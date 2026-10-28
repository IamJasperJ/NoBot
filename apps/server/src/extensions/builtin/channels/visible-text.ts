import { toDisplayText } from '@nobot/core/stage'
import type { MessageDTO } from '@nobot/shared'

export const isImageMessage = (message: MessageDTO) =>
  message.role !== 'user' && !!(message.meta.imageGen || message.meta.images?.length)

/** 工具协议和生图的历史描述只供模型读取，不能当成平台正文或语音。 */
export function visibleContent(message: MessageDTO): string {
  if (message.role === 'tool') return ''
  let content = message.content
  if (message.meta.toolCalls?.some((call) => content.trim() === call.arguments.trim())) return ''
  if (isImageMessage(message)) {
    if (
      message.meta.clientMessageId === 'imagine' ||
      content.trim() === message.meta.imageGen?.prompt?.trim() ||
      content.trim() === message.meta.imageGen?.caption?.trim()
    )
      return ''
    content = content.replace(/^.*? sends a picture that contains:[\s\S]*$/im, '')
    if (/^\s*(?:\{[\s\S]*"(?:task_id|status)"|Image generat(?:ed|ion failed))/i.test(content)) return ''
  }
  return cleanProtocolText(content)
}

/** 流式片段也使用相同过滤，未闭合的内部区块继续隐藏。 */
export function cleanProtocolText(content: string): string {
  return content
    .replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(
      /<(?:tool_call|tool_calls|function_call|function_calls)\b[^>]*>[\s\S]*?(?:<\/(?:tool_call|tool_calls|function_call|function_calls)>|$)/gi,
      '',
    )
    .trim()
}

/** 舞台正文与网页共用解析器，元数据不回填成可见文本。 */
export const visibleText = (message: MessageDTO) =>
  toDisplayText(visibleContent(message), { knownNames: [], speaker: 'plain', streaming: false })
