/** 引擎没有报告偏移时，扫描首个语法错误，为工作流编辑器提供可定位的行列。 */
function syntaxOffset(source: string): number {
  let cursor = 0
  const fail = (): never => {
    throw cursor
  }
  const space = () => {
    while (/[\x20\t\r\n]/.test(source[cursor] ?? '\0')) cursor++
  }
  const string = () => {
    if (source[cursor++] !== '"') {
      cursor--
      fail()
    }
    while (cursor < source.length) {
      const char = source[cursor++]!
      if (char === '"') return
      if (char < ' ') {
        cursor--
        fail()
      }
      if (char === '\\') {
        const escaped = source[cursor++]
        if (escaped === 'u') {
          for (let i = 0; i < 4; i++)
            if (!/[\da-f]/i.test(source[cursor++] ?? '!')) {
              cursor--
              fail()
            }
        } else if (!escaped || !'"\\/bfnrt'.includes(escaped)) {
          cursor--
          fail()
        }
      }
    }
    fail()
  }
  const value = () => {
    space()
    const char = source[cursor]
    if (char === '"') {
      string()
      return
    }
    if (char === '{' || char === '[') {
      cursor++
      space()
      const close = char === '{' ? '}' : ']'
      if (source[cursor] === close) {
        cursor++
        return
      }
      while (cursor < source.length) {
        if (char === '{') {
          space()
          string()
          space()
          if (source[cursor] !== ':') fail()
          cursor++
        }
        value()
        space()
        if (source[cursor] === close) {
          cursor++
          return
        }
        if (source[cursor] !== ',') fail()
        cursor++
        space()
      }
      fail()
    }
    const token = source.slice(cursor).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0]
    if (!token) fail()
    cursor += token!.length
  }
  try {
    value()
    space()
    if (cursor !== source.length) fail()
  } catch {
    return Math.min(cursor, source.length)
  }
  return cursor
}
export function workflowValidationError(source: string): string {
  try {
    const value: unknown = JSON.parse(source)
    return !value || typeof value !== 'object' || Array.isArray(value)
      ? 'ComfyUI 工作流必须是 API 格式的 JSON 对象'
      : ''
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const offset = Number(detail.match(/position (\d+)/)?.[1] ?? syntaxOffset(source))
    const before = source.slice(0, offset)
    const line = before.split('\n').length
    const column = offset - before.lastIndexOf('\n')
    return `ComfyUI 工作流不是合法的 JSON（第 ${line} 行，第 ${column} 列）：${detail}`
  }
}
