/** 工具结果必须连续跟在调用后；不支持工具图片的协议在整组结果之后补发 user 图片。 */
export function toolImageFallback(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  let pending: unknown[] = []
  const names = new Map<string, string>()
  const flush = () => {
    if (pending.length) result.push({ role: 'user', content: pending })
    pending = []
  }
  for (const message of messages) {
    if (message.role !== 'tool') flush()
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) names.set(call.id, call.function.name)
    }
    if (message.role === 'tool' && Array.isArray(message.content)) {
      const parts = message.content as { type: string; text?: string }[]
      const images = parts.filter((part) => part.type === 'image_url')
      result.push({
        ...message,
        content: parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n'),
      })
      if (images.length)
        pending.push(
          {
            type: 'text',
            text: `Images returned by tool ${names.get(String(message.tool_call_id)) ?? message.name ?? 'tool'}:`,
          },
          ...images,
        )
    } else result.push(message)
  }
  flush()
  return result
}
