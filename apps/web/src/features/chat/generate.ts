import { type GenerateEvent, type GenerateInput, parseSSE } from '@ai-parter/shared'
import type { QueryClient } from '@tanstack/react-query'
import { readError } from '../../api/client'
import { applyNewMessage, markIdle, replaceMessage, resetChat } from '../../api/queries'
import { useStreaming } from '../../stores/streaming'
import { toast } from '../../stores/toast'

/**
 * 发起生成（或重新接上进行中的生成），读取后端推送的 SSE 事件并更新界面。
 *
 * 性能要点：模型每秒可能推几十个分片。分片先攒在 pending 里，
 * 用 requestAnimationFrame 每帧最多提交一次给 React，上限每秒 60 次。
 *
 * 发起失败（比如没配置接口）时抛出异常，由调用方提示并恢复输入框内容。
 */
/** 正在读流的会话。同一个会话同时只读一条流，否则内容会重复 */
const activeStreams = new Set<string>()

export async function runGeneration(qc: QueryClient, chatId: string, input: GenerateInput | 'reconnect') {
  if (activeStreams.has(chatId)) {
    if (input === 'reconnect') return
    throw new Error('这个会话正在生成中')
  }
  activeStreams.add(chatId)
  try {
    await readStream(qc, chatId, input)
  } finally {
    activeStreams.delete(chatId)
    // 不管怎么结束的，后端这次生成都已经结束（或已断开），清掉「生成中」标记
    markIdle(qc, chatId)
  }
}

async function readStream(qc: QueryClient, chatId: string, input: GenerateInput | 'reconnect') {
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

  const streaming = useStreaming.getState()
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

  let finished = false
  try {
    for await (const msg of parseSSE(res.body)) {
      const e = JSON.parse(msg.data) as GenerateEvent
      switch (e.type) {
        case 'start': {
          // 先放用户消息，再放空的助手消息；父节点找不到说明缓存过期了，整页重拉
          const ok =
            (!e.userMessage || applyNewMessage(qc, chatId, e.userMessage)) &&
            applyNewMessage(qc, chatId, e.assistantMessage)
          if (!ok) void resetChat(qc, chatId)
          streaming.begin(chatId, e.assistantMessage.id)
          break
        }
        case 'delta':
          pendingText += e.text
          pendingReasoning += e.reasoning ?? ''
          frame ||= requestAnimationFrame(flush)
          break
        case 'error':
          toast.error(e.message)
          break
        case 'done':
          finished = true
          cancelAnimationFrame(frame)
          flush()
          // 先把最终内容写进缓存，再清空流式状态，避免画面闪一下空白
          replaceMessage(qc, chatId, e.message)
          useStreaming.getState().end()
          break
      }
    }
  } finally {
    if (!finished) {
      // 连接中途断了：后端的任务可能还在跑，重新拉一次会话，状态以后端为准
      cancelAnimationFrame(frame)
      useStreaming.getState().end()
      void resetChat(qc, chatId)
    }
  }
}
