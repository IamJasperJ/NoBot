import {
  type GenerateEvent,
  type GenerateInput,
  type ImpersonateEvent,
  type MessageDTO,
  parseSSE,
} from '@ai-parter/shared'
import type { QueryClient } from '@tanstack/react-query'
import { readError } from '../../api/client'
import { applyNewMessage, markIdle, refreshChatState, replaceMessage, resetChat } from '../../api/queries'
import { emitCommandEvent } from '../../commands/events'
import { emitClientEvent } from '../../extensions/runtime'
import { t } from '../../i18n'
import { registerFreshMessage } from '../../stores/freshMessages'
import { useStreaming } from '../../stores/streaming'
import { toast } from '../../stores/toast'

/** 正在读流的会话。同一个会话同时只读一条流，否则内容会重复 */
const activeStreams = new Set<string>()
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
  if (activeStreams.has(chatId)) {
    if (input === 'reconnect') return
    throw new Error(t('这个会话正在生成中'))
  }
  activeStreams.add(chatId)
  emitClientEvent({ type: 'generation:start', chatId })
  const completedMessages: MessageDTO[] = []
  let userSent = false
  try {
    await readStream(
      qc,
      chatId,
      input,
      (message) => completedMessages.push(message),
      () => {
        userSent = true
      },
    )
  } finally {
    activeStreams.delete(chatId)
    for (const resolve of idleWaiters.get(chatId) ?? []) resolve()
    idleWaiters.delete(chatId)
    emitClientEvent({ type: 'generation:complete', chatId })
    if (userSent) emitCommandEvent({ type: 'onUser', chatId, depth: automationDepth })
    if (completedMessages.length)
      emitCommandEvent({ type: 'onAi', chatId, depth: automationDepth, messages: completedMessages })
    // 不管怎么结束的，后端这次生成都已经结束（或已断开），清掉「生成中」标记
    markIdle(qc, chatId)
  }
}

async function readStream(
  qc: QueryClient,
  chatId: string,
  input: GenerateInput | 'reconnect',
  onDone: (message: MessageDTO) => void,
  onUser: () => void,
) {
  const res =
    input === 'reconnect'
      ? await fetch(`/api/chats/${chatId}/stream`)
      : await fetch(`/api/chats/${chatId}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        })
  if (!res.ok || !res.body) {
    const err = await readError(res)
    // 想接上的生成刚好已经结束了，不算错误，重新拉一次会话就行
    if (input === 'reconnect' && err.code === 'NO_JOB') return void resetChat(qc, chatId)
    throw err
  }

  let pendingText = ''
  let pendingReasoning = ''
  let frame = 0
  const flush = () => {
    frame = 0
    if (!pendingText && !pendingReasoning) return
    useStreaming.getState().append(pendingText, pendingReasoning)
    pendingText = ''
    pendingReasoning = ''
  }

  let completed = false
  try {
    for await (const msg of parseSSE(res.body)) {
      const e = JSON.parse(msg.data) as GenerateEvent
      switch (e.type) {
        case 'start': {
          if (e.userMessage) {
            registerFreshMessage(e.userMessage.id)
            onUser()
          }
          // 先放用户消息，再放助手消息；父节点找不到说明缓存过期了，整页重拉
          const ok =
            (!e.userMessage || applyNewMessage(qc, chatId, e.userMessage)) &&
            applyNewMessage(qc, chatId, e.assistantMessage)
          if (!ok) void resetChat(qc, chatId)
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
          replaceMessage(qc, chatId, e.message)
          useStreaming.getState().end()
          break
        case 'message':
          registerFreshMessage(e.message.id)
          if (e.message.role === 'user') onUser()
          if (!applyNewMessage(qc, chatId, e.message)) void resetChat(qc, chatId)
          break
        case 'error':
          toast.error(e.message)
          break
        case 'complete':
          completed = true
          // 舞台和变量沿路径累加，新回复入库后要跟着刷新
          void refreshChatState(qc, chatId)
          break
      }
    }
  } finally {
    cancelAnimationFrame(frame)
    useStreaming.getState().end()
    if (!completed) {
      // 连接中途断了：后端的任务可能还在跑，重新拉一次会话，状态以后端为准
      void resetChat(qc, chatId)
    }
  }
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
      const res = await fetch(`/api/chats/${chatId}/impersonate`, { method: 'POST', signal: controller.signal })
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
