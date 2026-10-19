/** 逐个尝试右括号，兼容代码围栏、嵌套对象及字符串里的花括号；只读取第一个对象。 */
export function firstJsonObject(text: string): unknown | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  for (let end = text.indexOf('}', start + 1); end >= 0; end = text.indexOf('}', end + 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      // 字符串内的右括号或嵌套对象尚未构成完整 JSON，继续向后找。
    }
  }
  return undefined
}
