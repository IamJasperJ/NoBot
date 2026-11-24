import { type GenerateEvent, type GenerateInput, type ImpersonateEvent, type MessageDTO, parseSSE } from '@nobot/shared'
import type { QueryClient } from '@tanstack/react-query'
import { readError } from '../../api/client'
import { apiFetch } from '../../api/fetch'
import {
  applyNewMessage,
  keys,
  refreshChatState,
  replaceMessage,
  resetChat,
  setChatGenerating,
} from '../../api/queries'
import { scopeForChat } from '../../api/room-scope'
import { clientMessageId, mergeMessage, roomsApi } from '../../api/rooms'
import { emitCommandEvent } from '../../commands/events'
import { emitClientEvent } from '../../extensions/runtime'
import { t } from '../../i18n'
import { registerFreshMessage } from '../../stores/freshMessages'
import { useStreaming } from '../../stores/streaming'
import { toast } from '../../stores/toast'

/** 正在读流的会话。同一个会话同时只读一条流，否则内容会重复 */
const activeStreams = new Map<string, { changed: boolean }>()
const cooling = new Map<string, { changed: boolean; timer: ReturnType<typeof setTimeout> }>()
const lastUserEvent = new WeakMap<QueryClient, Map<string, string>>()

/**
 * 后台（渠道消息等）改了会话：有进行中的生成就接上流，没有就重拉最新一页。
 * 只处理已经打开过的会话；生成期间的其他改动在收尾后合并为一次同步。
 */
export function syncChatFromServer(qc: QueryClient, chatId: string) {
  if (!qc.getQueryData(keys.chat(chatId))) return
  const recent = activeStreams.get(chatId) ?? cooling.get(chatId)
  if (recent) {
    recent.changed = true
    return
  }
  void runGeneration(qc, chatId, 'reconnect').catch(() => resetChat(qc, chatId))
}
const idleWaiters = new Map<string, Set<() => void>>()

/** 自动执行可以排在已有生成后面，避免切换会话或命令管道占用同一条流。 */
export function waitForGenerationIdle(chatId: string): Promise<void> {
  if (!activeStreams.has(chatId)) return Promise.resolve()
  return new Promise((resolve) => {
    const waiters = idleWaiters.get(chatId) ?? new Set()
    waiters.add(resolve)
    idleWaiters.set(chatId, waiters)
  })
}

/**
 * 发起生成（或重新接上进行中的生成），读取后端推送的 SSE 事件并更新界面。
 *
 * 一次生成任务可能产出多条消息（群聊轮流发言、工具调用后接着写）：
 * 每条助手消息是 start → delta… → done，工具结果是 message，整个任务结束是 complete。
 *
 * 性能要点：模型每秒可能推几十个分片。分片先攒在 pending 里，
 * 用 requestAnimationFrame 每帧最多提交一次给 React，上限每秒 60 次。
 *
 * 发起失败（比如没配置连接）时抛出异常，由调用方提示并恢复输入框内容。
 */
export async function runGeneration(
  qc: QueryClient,
  chatId: string,
  input: GenerateInput | 'reconnect',
  automationDepth = 0,
) {
  const roomId = scopeForChat(chatId)
  if (roomId) {
    if (input === 'reconnect') return
    if (input.mode === 'send') {
      const message = await roomsApi.send({
        id: roomId,
        input: { text: input.text, channel: 'ic', clientMessageId: clientMessageId(), images: input.images },
      })
      mergeMessage(message)
    } else {
      const response = await apiFetch(`/api/chats/${chatId}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      if (!response.ok) throw await readError(response)
    }
    return
  }
  if (activeStreams.has(chatId)) {
    if (input === 'reconnect') return
    throw new Error(t('这个会话正在生成中'))
  }
  const stream = { changed: false }
  activeStreams.set(chatId, stream)
  emitClientEvent({ type: 'generation:start', chatId })
  const completedMessages: MessageDTO[] = []
  let userSent = false
  let finished = false
  const seen = lastUserEvent.get(qc) ?? new Map<string, string>()
  lastUserEvent.set(qc, seen)
  const receive = (source: typeof input) =>
    readStream(
      qc,
      chatId,
      source,
      (message) => completedMessages.push(message),
      (message) => {
        if (seen.get(chatId) === message.id) return
        seen.set(chatId, message.id)
        registerFreshMessage(message.id)
        userSent = true
      },
    )
  try {
    finished = await receive(input)
    if (!finished) {
      // 重连沿用原生成的自动执行深度，重试期间继续占用会话的流。
      await new Promise((resolve) => setTimeout(resolve, 1500))
      finished = await receive('reconnect').catch(() => false)
    }
  } finally {
    activeStreams.delete(chatId)
    const previous = cooling.get(chatId)
    clearTimeout(previous?.timer)
    cooling.set(chatId, {
      changed: stream.changed || (previous?.changed ?? false),
      timer: setTimeout(() => {
        const recent = cooling.get(chatId)
        cooling.delete(chatId)
        if (recent?.changed) syncChatFromServer(qc, chatId)
      }, 1500),
    })
    for (const resolve of idleWaiters.get(chatId) ?? []) resolve()
    idleWaiters.delete(chatId)
    if (finished) emitClientEvent({ type: 'generation:complete', chatId })
    if (userSent) emitCommandEvent({ type: 'onUser', chatId, depth: automationDepth })
    if (completedMessages.length)
      emitCommandEvent({ type: 'onAi', chatId, depth: automationDepth, messages: completedMessages })
  }
}

async function readStream(
  qc: QueryClient,
  chatId: string,
  input: GenerateInput | 'reconnect',
  onDone: (message: MessageDTO) => void,
  onUser: (message: MessageDTO) => void,
) {
  const res =
    input === 'reconnect'
      ? await apiFetch(`/api/chats/${chatId}/stream`)
      : await apiFetch(`/api/chats/${chatId}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        })
  if (!res.ok || !res.body) {
    const err = await readError(res)
    // 想接上的生成刚好已经结束了，不算错误，重新拉一次会话就行
    if (input === 'reconnect' && err.code === 'NO_JOB') {
      setChatGenerating(qc, chatId, false)
      await resetChat(qc, chatId)
      return true
    }
    throw err
  }
  setChatGenerating(qc, chatId, true)

  let pendingText = ''
  let pendingReasoning = ''
  let frame = 0
  const flush = () => {
    frame = 0
    if (!pendingText && !pendingReasoning) return
    useStreaming.getState().append(pendingText, pendingReasoning, chatId)
    pendingText = ''
    pendingReasoning = ''
  }

  let completed = false
  let missingPath = false
  try {
    for await (const msg of parseSSE(res.body)) {
      const e = JSON.parse(msg.data) as GenerateEvent
      switch (e.type) {
        case 'start': {
          if (e.userMessage) onUser(e.userMessage)
          // 父节点不在本地时等流结束后统一重拉，避免在途快照覆盖新的消息。
          const ok =
            (!e.userMessage || applyNewMessage(qc, chatId, e.userMessage)) &&
            applyNewMessage(qc, chatId, e.assistantMessage)
          missingPath ||= !ok
          // 续写时 assistantMessage.content 是原有内容，流式文本从它开始累加
          useStreaming.getState().begin(chatId, e.assistantMessage.id, e.assistantMessage.content)
          break
        }
        case 'delta':
          pendingText += e.text
          pendingReasoning += e.reasoning ?? ''
          frame ||= requestAnimationFrame(flush)
          break
        case 'done':
          registerFreshMessage(e.message.id)
          onDone(e.message)
          cancelAnimationFrame(frame)
          flush()
          // 先把最终内容写进缓存，再清空流式状态，避免画面闪一下空白
          if (!replaceMessage(qc, chatId, e.message) && !applyNewMessage(qc, chatId, e.message)) missingPath = true
          useStreaming.getState().end(chatId)
          break
        case 'message':
          if (e.message.role === 'user') onUser(e.message)
          else registerFreshMessage(e.message.id)
          // 中止工具调用时可能收到祖先消息的状态更新，保留已写入的工具结果。
          if (!replaceMessage(qc, chatId, e.message) && !applyNewMessage(qc, chatId, e.message)) missingPath = true
          break
        case 'error':
          toast.error(e.message)
          break
        case 'complete':
          completed = true
          break
      }
      if (completed) break
    }
  } catch {
    // 后端已接受生成；连接出错时重同步，避免把已提交的输入交还给编辑框重发。
  } finally {
    cancelAnimationFrame(frame)
    useStreaming.getState().end(chatId)
    if (completed) setChatGenerating(qc, chatId, false)
    if (!completed || missingPath || input === 'reconnect') {
      await resetChat(qc, chatId)
    } else {
      // 舞台和变量沿路径累加，新回复入库后要跟着刷新。
      void refreshChatState(qc, chatId)
    }
  }
  return completed
}

/**
 * 代写：让 AI 替用户写一条，逐字回调 onText，不入库。
 * 返回一个函数，调用它可以中止。
 */
export function runImpersonate(
  chatId: string,
  handlers: { onText: (text: string) => void; onDone: () => void; onError: (message: string) => void },
): () => void {
  const controller = new AbortController()
  void (async () => {
    try {
      const res = await apiFetch(`/api/chats/${chatId}/impersonate`, { method: 'POST', signal: controller.signal })
      if (!res.ok || !res.body) throw await readError(res)
      for await (const msg of parseSSE(res.body)) {
        const e = JSON.parse(msg.data) as ImpersonateEvent
        if (e.type === 'delta') handlers.onText(e.text)
        else if (e.type === 'error') handlers.onError(e.message)
      }
    } catch (e) {
      if (!controller.signal.aborted) handlers.onError(e instanceof Error ? e.message : String(e))
    } finally {
      handlers.onDone()
    }
  })()
  return () => controller.abort()
}
