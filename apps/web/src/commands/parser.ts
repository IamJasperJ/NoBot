import { t } from '../i18n'

export interface ParsedCommand {
  name: string
  args: Record<string, string>
  text: string
}

/** 只识别简单管道；先分段再解析，避免宏的结果被当作新命令执行。 */
export function splitPipeline(source: string): string[] {
  const parts: string[] = []
  let start = 0
  let quote = ''
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!
    if (ch === '\\') {
      i++
      continue
    }
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '|') {
      parts.push(source.slice(start, i))
      start = i + 1
    }
  }
  if (quote) throw new Error(t('引号未闭合'))
  parts.push(source.slice(start))
  return parts
}

/** 引号可以出现在命名参数值内；未知转义保留反斜杠，以免破坏路径。 */
export function parseCommand(source: string): ParsedCommand {
  const match = source.trim().match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/)
  if (!match) throw new Error(t('命令格式无效'))
  const args: Record<string, string> = Object.create(null)
  let text = ''
  let tokenStart = 0
  let previousFreeEnd: number | null = null
  const body = match[2] ?? ''
  let value = ''
  let quote = ''
  let started = false
  let assignment = -1
  const flush = (end: number) => {
    if (!started) return
    if (assignment > 0 && /^[\w-]+$/.test(value.slice(0, assignment))) {
      args[value.slice(0, assignment)] = value.slice(assignment + 1)
      previousFreeEnd = null
    } else {
      // 保留自由文本内部的换行和空格，移除命名参数时才补一个分隔空格。
      if (text) text += previousFreeEnd === null ? ' ' : body.slice(previousFreeEnd, tokenStart)
      text += value
      previousFreeEnd = end
    }
    value = ''
    started = false
    assignment = -1
  }
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!
    if (!started && !/\s/.test(ch)) tokenStart = i
    if (ch === '\\' && i + 1 < body.length && /[\\|"'\s=]/.test(body[i + 1]!)) {
      value += body[++i]
      started = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = ''
      else value += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      flush(i)
      continue
    }
    if (ch === '=' && assignment < 0) assignment = value.length
    value += ch
    started = true
  }
  if (quote) throw new Error(t('引号未闭合'))
  flush(body.length)
  return { name: match[1]!.toLowerCase(), args, text }
}
export const parseCommandLine = (text: string): ParsedCommand[] => splitPipeline(text).map(parseCommand)
