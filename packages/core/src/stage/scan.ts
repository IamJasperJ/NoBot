export interface Tag {
  start: number
  end: number
  name: string
  closing: boolean
  self: boolean
  attrs: Record<string, string>
  raw?: string
  close?: number
}

/** 一次扫描标签，再反向索引结束标签，未闭合的块也不会反复搜索余下全文。 */
export function scanTags(source: string): Tag[] {
  const tags: Tag[] = []
  const head = /<\/?([a-z][\w-]*)\b/iy
  let pos = 0
  while (pos < source.length) {
    if (source[pos] !== '<') {
      pos++
      continue
    }
    head.lastIndex = pos
    const match = head.exec(source)
    if (!match) {
      pos++
      continue
    }
    const start = pos
    pos = head.lastIndex
    const attrsStart = pos
    let quote = ''
    while (pos < source.length) {
      const c = source[pos++]!
      if (quote) {
        if (c === quote) quote = ''
      } else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
    }
    if (source[pos - 1] !== '>' || quote) break
    const raw = source.slice(attrsStart, pos - 1)
    tags.push({
      start,
      end: pos,
      name: match[1]!.toLowerCase(),
      closing: source[start + 1] === '/',
      self: raw.trimEnd().endsWith('/'),
      attrs: attributes(raw),
      raw,
    })
  }
  const closes = new Map<string, number[]>()
  for (let i = tags.length - 1; i >= 0; i--) {
    const tag = tags[i]!
    if (tag.closing) {
      const stack = closes.get(tag.name) ?? []
      stack.push(i)
      closes.set(tag.name, stack)
    } else if (!tag.self) tag.close = closes.get(tag.name)?.pop()
  }
  return tags
}

function attributes(raw: string): Record<string, string> {
  raw = raw.trimEnd()
  if (raw.endsWith('/')) raw = raw.slice(0, -1)
  const attrs: Record<string, string> = Object.create(null)
  let pos = 0
  while (pos < raw.length) {
    if (!/[\w-]/.test(raw[pos]!)) {
      pos++
      continue
    }
    const start = pos
    while (pos < raw.length && /[\w-]/.test(raw[pos]!)) pos++
    const key = raw.slice(start, pos).toLowerCase()
    while (pos < raw.length && /\s/.test(raw[pos]!)) pos++
    if (raw[pos] !== '=') continue
    pos++
    while (pos < raw.length && /\s/.test(raw[pos]!)) pos++
    const quote = raw[pos] === '"' || raw[pos] === "'" ? raw[pos++] : undefined
    const valueStart = pos
    if (quote) while (pos < raw.length && raw[pos] !== quote) pos++
    else while (pos < raw.length && !/\s/.test(raw[pos]!)) pos++
    attrs[key] = raw.slice(valueStart, pos)
    if (quote && pos < raw.length) pos++
  }
  return attrs
}

export interface Speech {
  speaker: string
  expression?: string
  text: string
  narrator: boolean
}

export function nameSet(names: string[]): Set<string> {
  return new Set(names.map((name) => name.trim().toLowerCase()))
}

export function shorthand(line: string, known: Set<string>, narrators: Set<string>): Speech | undefined {
  line = line.trimStart()
  // 已知名字优先取最长前缀，避免名字内的冒号或方括号被当成台词分隔符。
  const names = [...new Set([...known, ...narrators])].sort((a, b) => b.length - a.length)
  for (const name of names) {
    if (!name || line.slice(0, name.length).toLowerCase() !== name) continue
    const suffix = /^(?:\[([^\]\r\n]+)\])?\s*[:：]\s*(.*)$/u.exec(line.slice(name.length))
    if (!suffix) continue
    const expression = suffix[1]?.trim()
    return {
      speaker: line.slice(0, name.length),
      ...(expression !== undefined ? { expression } : {}),
      text: suffix[2]!,
      narrator: narrators.has(name),
    }
  }
  const match = /^([^[\]:：「」<>\r\n]{1,24}?)(?:\[([^\]\r\n]+)\])?\s*[:：]\s*(.*)$/u.exec(line)
  if (!match) return
  const speaker = match[1]!.trim()
  if (!speaker || /^[*「」『』“”‘’"']/.test(speaker) || Array.from(speaker).length > 24) return
  const key = speaker.toLowerCase()
  const expression = match[2]?.trim()
  const text = match[3]!
  const narrator = narrators.has(key)
  if (!narrator && !known.has(key) && expression === undefined) {
    // 未知名字只能省略表情写完整引号台词，避免把叙述句的冒号误当成说话人分隔符。
    const closing = ({ '「': '」', '『': '』', '“': '”', '"': '"' } as Record<string, string>)[text[0] ?? '']
    const end = closing ? text.indexOf(closing, 1) : -1
    if (end < 0 || !/^[\s\p{P}]*$/u.test(text.slice(end + 1))) return
  }
  return { speaker, ...(expression !== undefined ? { expression } : {}), text, narrator }
}
