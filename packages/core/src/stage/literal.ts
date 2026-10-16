/** 只读取数据字面量，不执行卡片或模型给出的代码。 */
export class LiteralReader {
  pos = 0
  constructor(readonly source: string) {}

  fail(): never {
    throw new Error(`字面量格式错误（位置 ${this.pos + 1}）`)
  }

  skip(): void {
    while (this.pos < this.source.length) {
      const c = this.source[this.pos]
      if (c && /\s/.test(c)) this.pos++
      else if (this.source.startsWith('//', this.pos)) {
        while (this.pos < this.source.length && this.source[this.pos] !== '\n') this.pos++
      } else if (this.source.startsWith('/*', this.pos)) {
        const end = this.source.indexOf('*/', this.pos + 2)
        if (end < 0) this.fail()
        this.pos = end + 2
      } else break
    }
  }

  string(): string {
    const quote = this.source[this.pos++]
    const parts: string[] = []
    let start = this.pos
    while (this.pos < this.source.length) {
      const c = this.source[this.pos++]
      if (c === quote) {
        parts.push(this.source.slice(start, this.pos - 1))
        return parts.join('')
      }
      if (c === '\n' || c === '\r') this.fail()
      if (c !== '\\') continue
      parts.push(this.source.slice(start, this.pos - 1))
      const escaped = this.source[this.pos++]
      if (escaped === undefined) this.fail()
      const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }
      if (escaped === 'u' || escaped === 'x') {
        const count = escaped === 'u' ? 4 : 2
        const digits = this.source.slice(this.pos, this.pos + count)
        if (digits.length !== count || !/^[\da-f]+$/i.test(digits)) this.fail()
        parts.push(String.fromCharCode(Number.parseInt(digits, 16)))
        this.pos += count
      } else if (escaped === '\r') {
        if (this.source[this.pos] === '\n') this.pos++
      } else if (escaped !== '\n') parts.push(simple[escaped] ?? escaped)
      start = this.pos
    }
    return this.fail()
  }

  value(): unknown {
    this.skip()
    const c = this.source[this.pos]
    if (c === '"' || c === "'") return this.string()
    if (c === '[' || c === '{') {
      this.pos++
      const close = c === '[' ? ']' : '}'
      const array: unknown[] = []
      const object: Record<string, unknown> = {}
      this.skip()
      while (this.source[this.pos] !== close) {
        if (this.pos >= this.source.length) this.fail()
        if (c === '[') array.push(this.value())
        else {
          this.skip()
          let key: string
          if (this.source[this.pos] === '"' || this.source[this.pos] === "'") key = this.string()
          else {
            const start = this.pos
            while (this.pos < this.source.length && !/[\s:,{}[\]/]/.test(this.source[this.pos]!)) this.pos++
            key = this.source.slice(start, this.pos)
            if (!/^(?:[$_\p{ID_Start}](?:[$_\p{ID_Continue}]|\u200c|\u200d)*|\d+)$/u.test(key)) this.fail()
          }
          this.skip()
          if (this.source[this.pos++] !== ':') this.fail()
          put(object, key, this.value())
        }
        this.skip()
        if (this.source[this.pos] === close) break
        if (this.source[this.pos++] !== ',') this.fail()
        this.skip()
      }
      this.pos++
      return c === '[' ? array : object
    }
    const start = this.pos
    while (this.pos < this.source.length && !/[\s,\])}/;]/.test(this.source[this.pos]!)) this.pos++
    const token = this.source.slice(start, this.pos)
    if (token === 'true') return true
    if (token === 'false') return false
    if (token === 'null') return null
    if (/^[+-]?(?:0[xX][\da-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)$/.test(token)) {
      const number = Number(token)
      if (Number.isFinite(number)) return number
    }
    return this.fail()
  }
}

export function parseLiteral(source: string): unknown {
  const reader = new LiteralReader(source)
  const value = reader.value()
  reader.skip()
  if (reader.pos !== source.length) reader.fail()
  return value
}

/** 路径完全由用户决定，不能让 __proto__ 这样的键改变对象原型。 */
export function put<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, { value, enumerable: true, configurable: true, writable: true })
}
