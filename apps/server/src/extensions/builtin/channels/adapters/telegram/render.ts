export type TelegramSegment = { kind: 'text' | 'emphasis' | 'speaker' | 'narration' | 'thinking'; text: string }
export const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const tags = {
  text: ['', ''],
  speaker: ['<b>', '</b>'],
  emphasis: ['<b>', '</b>'],
  narration: ['<i>', '</i>'],
  thinking: ['<blockquote expandable>', '</blockquote>'],
} as const

/** 先按原始文本的 UTF-16 单位切分，再转义并单独闭合标签，实体、标签和代理对都不会被拆开。 */
export function renderTelegram(segments: TelegramSegment[], limit = 4096): string[] {
  if (limit < 2) throw new RangeError('limit')
  const pages: string[] = []
  let page = '',
    length = 0
  for (const segment of segments) {
    let remaining = segment.text
    while (remaining) {
      let available = limit - length
      if (available < 2 && remaining.codePointAt(0)! > 0xffff) {
        pages.push(page)
        page = ''
        length = 0
        available = limit
      }
      let end = Math.min(remaining.length, available)
      if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1] ?? '')) end--
      if (end < remaining.length) {
        const head = remaining.slice(0, end)
        const boundaries = [...head.matchAll(/\n\n|[。！？.!?]\s*|\n/g)]
        const boundary = boundaries.at(-1)
        const at = boundary ? boundary.index + boundary[0].length : 0
        if (at > end / 2) end = at
      }
      const text = remaining.slice(0, end)
      const [open, close] = tags[segment.kind]
      page += `${open}${escapeHtml(text)}${close}`
      length += text.length
      remaining = remaining.slice(end)
      if (remaining || length === limit) {
        pages.push(page)
        page = ''
        length = 0
      }
    }
  }
  if (page) pages.push(page)
  return pages
}

/** 与聊天显示的轻量格式一致，只有星号标记的动作使用斜体，普通文字保持原样。 */
export function inlineTelegramSegments(text: string): TelegramSegment[] {
  return text.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g).map((part, index) => {
    if (index % 2 === 0) return { kind: 'text', text: part }
    if (part.startsWith('**')) return { kind: 'emphasis', text: part.slice(2, -2) }
    return { kind: 'narration', text: part.slice(1, -1) }
  })
}
