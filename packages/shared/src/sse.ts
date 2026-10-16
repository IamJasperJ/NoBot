import type { MessageDTO } from './schemas/message'

/**
 * 生成接口通过 SSE 推送的事件。一次生成任务可能产出多条消息
 * （群聊多个角色轮流说、工具调用后接着写），所以：
 * - 每条新的助手消息：start → delta… → done
 * - 工具结果等直接完成的消息：message
 * - 整个任务结束：complete
 */
export type GenerateEvent =
  | {
      type: 'start'
      /** send 模式下新插入的用户消息 */
      userMessage?: MessageDTO
      /** 正在生成的助手消息。续写时 content 是原有内容，后续 delta 接在后面 */
      assistantMessage: MessageDTO
    }
  | { type: 'delta'; text: string; reasoning?: string }
  | { type: 'done'; message: MessageDTO }
  | { type: 'message'; message: MessageDTO }
  | { type: 'error'; code: string; message: string }
  | { type: 'complete' }

/** 代写接口的事件：只推文本，不入库 */
export type ImpersonateEvent =
  | { type: 'delta'; text: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'complete' }

export interface SSEMessage {
  event: string
  data: string
}

/**
 * 把一个字节流解析成 SSE 消息。
 * 后端解析模型接口的流、前端解析我们自己后端的流，用的都是这个函数。
 */
export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = 'message'
  let dataLines: string[] = []

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      // stream: true 让被切断的多字节字符（比如中文）留到下一块再解码
      buffer += decoder.decode(value, { stream: true })

      // 按行切分，最后一段可能是不完整的行，留到下一轮
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line === '') {
          // 空行表示一条消息结束
          if (dataLines.length > 0) {
            yield { event, data: dataLines.join('\n') }
          }
          event = 'message'
          dataLines = []
        } else if (line.startsWith(':')) {
          // 注释行（心跳），忽略
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim()
        }
      }
    }
    // 流结束时如果还有没收尾的消息，也吐出来
    if (dataLines.length > 0) {
      yield { event, data: dataLines.join('\n') }
    }
  } finally {
    reader.releaseLock()
  }
}
