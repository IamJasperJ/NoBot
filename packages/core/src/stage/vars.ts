import { type StateSchema, stateSchemaSchema } from '@nobot/shared'
import { LiteralReader, parseLiteral, put } from './literal'
import { scanTags } from './scan'

export class VariableUpdates {
  readonly patch: Record<string, unknown> = {}
  constructor(readonly initial: Record<string, unknown>) {}

  current(path: string): unknown {
    return Object.hasOwn(this.patch, path)
      ? this.patch[path]
      : Object.hasOwn(this.initial, path)
        ? this.initial[path]
        : undefined
  }

  set(path: string, value: unknown): void {
    put(this.patch, path, value)
  }

  add(path: string, delta: number): void {
    const current = this.current(path)
    this.set(path, (typeof current === 'number' ? current : 0) + delta)
  }

  inline(source: string, warnings: string[]): void {
    for (const raw of source.split(/\r?\n/)) {
      const line = stripComment(raw).trim()
      if (!line) continue
      const deletion = /^delete\s+(.+)$/.exec(line)
      if (deletion) {
        this.set(deletion[1]!.trim(), null)
        continue
      }
      const match = stateStatement(line)
      if (!match) {
        warnings.push(`无法解析状态语句：${line}`)
        continue
      }
      const { path, op, rawValue } = match
      if (!path) continue
      if (op === '+=' || op === '-=') {
        const delta = Number(rawValue)
        if (!rawValue || !Number.isFinite(delta)) warnings.push(`状态增减值不是数字：${line}`)
        else this.add(path, op === '+=' ? delta : -delta)
      } else {
        const value = inlineValue(rawValue)
        if (op === '=') this.set(path, value)
        else {
          const current = this.current(path)
          const array = Array.isArray(current) ? [...current] : []
          if (op === 'push') array.push(value)
          else {
            const index = array.findIndex((item) => equal(item, value))
            if (index >= 0) array.splice(index, 1)
          }
          this.set(path, array)
        }
      }
    }
  }
}

/** 逐字寻找操作符，长路径或长空白不使用相互重叠的正则量词。 */
function stateStatement(line: string): { path: string; op: string; rawValue: string } | undefined {
  for (let pos = 0; pos < line.length; pos++) {
    const start = pos
    let op = ''
    if (line[pos] === '=') {
      op = '='
      pos++
    } else if ((line[pos] === '+' || line[pos] === '-') && line[pos + 1] === '=') {
      op = line.slice(pos, pos + 2)
      pos += 2
    } else if (/\s/.test(line[pos]!)) {
      while (pos < line.length && /\s/.test(line[pos]!)) pos++
      for (const word of ['push', 'remove']) {
        if (line.startsWith(word, pos) && /\s/.test(line[pos + word.length] ?? '')) {
          op = word
          pos += word.length
          break
        }
      }
      if (!op) {
        pos--
        continue
      }
    }
    if (op) return { path: line.slice(0, start).trim(), op, rawValue: line.slice(pos).trim() }
  }
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => equal(item, b[i]))
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
  }
  return false
}

function stripComment(line: string): string {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
    } else if (c === '"' || c === "'" || c === '「' || c === '“') quote = c === '「' ? '」' : c === '“' ? '”' : c
    else if (c === '/' && line[i + 1] === '/') return line.slice(0, i)
  }
  return line
}

function inlineValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    for (const [open, close] of [
      ['"', '"'],
      ["'", "'"],
      ['「', '」'],
      ['“', '”'],
    ]) {
      if (raw.length >= 2 && raw.startsWith(open!) && raw.endsWith(close!)) return raw.slice(1, -1)
    }
    return raw
  }
}

export interface MvuCall {
  start: number
  end: number
  method: 'set' | 'add'
  path: string
  value: unknown
}

/** 用同一个字面量读取器读参数，逗号或括号出现在字符串、数组中时不会误切。 */
export function mvuCalls(source: string, ignoreTags = false): MvuCall[] {
  const tags = ignoreTags ? scanTags(source) : []
  let tagIndex = 0
  const calls: MvuCall[] = []
  const head = /_\.(set|add)\s*\(/gy
  let pos = 0
  while (pos < source.length) {
    while (tagIndex < tags.length && tags[tagIndex]!.start < pos) tagIndex++
    const tag = tags[tagIndex]
    if (tag?.start === pos) {
      pos = tag.close !== undefined ? tags[tag.close]!.end : tag.self || tag.closing ? tag.end : source.length
      tagIndex++
      continue
    }
    if (source.startsWith('//', pos)) {
      const end = source.indexOf('\n', pos + 2)
      pos = end < 0 ? source.length : end + 1
      continue
    }
    if (source.startsWith('/*', pos)) {
      const end = source.indexOf('*/', pos + 2)
      pos = end < 0 ? source.length : end + 2
      continue
    }
    if (source[pos] !== '_' || (pos > 0 && /[\w$]/.test(source[pos - 1]!))) {
      pos++
      continue
    }
    head.lastIndex = pos
    const match = head.exec(source)
    if (!match) {
      pos++
      continue
    }
    const reader = new LiteralReader(source)
    reader.pos = head.lastIndex
    try {
      const args: unknown[] = []
      for (;;) {
        args.push(reader.value())
        reader.skip()
        if (source[reader.pos] === ')') break
        if (source[reader.pos++] !== ',' || args.length >= 3) reader.fail()
      }
      reader.pos++
      if (source[reader.pos] === ';') reader.pos++
      const method = match[1] as 'set' | 'add'
      if (
        typeof args[0] === 'string' &&
        ((method === 'set' && (args.length === 2 || args.length === 3)) ||
          (method === 'add' && args.length === 2 && typeof args[1] === 'number'))
      ) {
        calls.push({ start: pos, end: reader.pos, method, path: args[0], value: args[args.length - 1] })
      }
    } catch {
      // 一条坏语句不应妨碍后面的正常内容，已读取的部分不再重复扫描。
    }
    pos = Math.max(pos + 1, reader.pos)
  }
  return calls
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseInitVars(entries: { comment: string; content: string }[]): {
  vars: Record<string, unknown>
  rules: Record<string, string>
  errors: string[]
} {
  const vars: Record<string, unknown> = {}
  const rules: Record<string, string> = {}
  const errors: string[] = []
  const flatten = (object: Record<string, unknown>, prefix = ''): void => {
    for (const [key, value] of Object.entries(object)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (Array.isArray(value) && value.length === 2 && typeof value[1] === 'string') {
        put(vars, path, value[0])
        put(rules, path, value[1])
      } else if (isObject(value)) flatten(value, path)
      else {
        put(vars, path, value)
        delete rules[path]
      }
    }
  }
  for (const entry of entries) {
    if (!entry.comment.includes('[InitVar]')) continue
    try {
      const value = parseLiteral(entry.content)
      if (!isObject(value)) throw new Error('初始变量必须是对象')
      flatten(value)
    } catch (error) {
      errors.push(`${entry.comment}：${error instanceof Error ? error.message : '解析失败'}`)
    }
  }
  return { vars, rules, errors }
}

export function parseStateSchema(text: string): { schema: StateSchema; error?: string } {
  if (!text.trim()) return { schema: {} }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { schema: {}, error: '状态定义不是合法的 JSON' }
  }
  const result = stateSchemaSchema.safeParse(value)
  if (!result.success)
    return {
      schema: {},
      error: `状态定义字段不合法：${result.error.issues.map((issue) => issue.path.join('.')).join('、')}`,
    }
  return { schema: result.data }
}

export function schemaInitVars(schema: StateSchema): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([, field]) => Object.hasOwn(field, 'init'))
      .map(([path, field]) => [path, field.init]),
  )
}
