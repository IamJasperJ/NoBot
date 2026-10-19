import { HttpError } from '../../../errors'
import { t } from '../../../i18n'

/** 使用每次请求独有的前缀，避免原文里的占位符示例被误还原。 */
export function protect(text: string) {
  const prefix = `ZXQ${crypto.randomUUID().replaceAll('-', '')}Q`
  const parts: { token: string; value: string }[] = []
  // 代码块优先整体保护；标签属性里的 > 不结束标签，速记连同名字和冒号一起保护。
  const pattern =
    /^[\t ]*```[^\n]*\n[\s\S]*?(?:```|$)|^[\t ]*~~~[^\n]*\n[\s\S]*?(?:~~~|$)|```[^`]*```|^[\t ]*[^\s<>[\]：:\n][^<>[\]：:\n]{0,79}\[[^\]\n]{1,64}\][\t ]*[：:]|<!--[\s\S]*?-->|<(?:"[^"]*"|'[^']*'|[^<>"'])+>|\{\{[^{}]*\}\}|\[[^\]\n]{1,64}\]|https?:\/\/[^\s<>]+/gm
  const value = text.replace(pattern, (value) => {
    const token = `${prefix}${parts.length}XZ`
    parts.push({ token, value })
    return token
  })
  return {
    text: value,
    tokens: parts.map((part) => part.token),
    restore(translated: string) {
      // 必须恰好出现一次，缺失、拆开和重复都不能静默产生损坏的正文。
      for (const part of parts) {
        if (translated.split(part.token).length !== 2)
          throw new HttpError(502, 'TRANSLATION_TOKEN', t('翻译服务损坏了保护标记'))
      }
      const restored = parts.reduce((result, part) => result.replace(part.token, () => part.value), translated)
      if (restored.includes(prefix)) throw new HttpError(502, 'TRANSLATION_TOKEN', t('翻译服务损坏了保护标记'))
      return restored
    },
  }
}

/** 按段落和长度分块；占位符不可切断，空白独立返回以便原样拼回。 */
export function splitTranslation(text: string, limit: number, tokens: string[]) {
  const chunks: string[] = []
  for (let paragraph of text.split(/(\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*)/)) {
    while (paragraph.length > limit && paragraph.trim()) {
      let end = limit
      for (const token of tokens) {
        const start = paragraph.indexOf(token)
        if (start >= 0 && start < end && start + token.length > end) end = start
      }
      // 不能切断 UTF-16 代理对。
      if (/[\uD800-\uDBFF]/.test(paragraph[end - 1] ?? '')) end--
      const boundary = Math.max(paragraph.lastIndexOf(' ', end - 1), paragraph.lastIndexOf('\n', end - 1))
      if (boundary >= end / 2) end = boundary + 1
      chunks.push(paragraph.slice(0, end))
      paragraph = paragraph.slice(end)
    }
    if (paragraph) chunks.push(paragraph)
  }
  return chunks
}
