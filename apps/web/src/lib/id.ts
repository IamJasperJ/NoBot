/**
 * 生成 UUID v4。crypto.randomUUID 只在安全上下文（HTTPS / localhost）里有，
 * 用 http + IP 访问时不存在；getRandomValues 不受这个限制，用它按 v4 格式拼一个
 */
export function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40 // 版本号 4
  b[8] = (b[8]! & 0x3f) | 0x80 // RFC 4122 变体
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
