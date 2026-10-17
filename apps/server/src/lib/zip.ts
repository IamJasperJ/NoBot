import { inflateRawSync } from 'node:zlib'
import { HttpError } from '../errors'

const MB = 1024 * 1024
const bad = (message: string): never => {
  throw new HttpError(400, 'BAD_ZIP', message)
}

/** 以中央目录为准读取，兼容使用数据描述符的 zip；解压上限同时约束声明值和实际输出。 */
export function readZip(bytes: Uint8Array): { path: string; data: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const check = (offset: number, size: number) => {
    if (offset < 0 || offset + size > bytes.length) bad('ZIP 文件不完整')
  }
  const u16 = (offset: number) => {
    check(offset, 2)
    return view.getUint16(offset, true)
  }
  const u32 = (offset: number) => {
    check(offset, 4)
    return view.getUint32(offset, true)
  }
  let end = bytes.length - 22
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length) break
  }
  if (end < Math.max(0, bytes.length - 65557)) bad('找不到 ZIP 中央目录')
  if (end >= 20 && u32(end - 20) === 0x07064b50) bad('不支持 ZIP64')
  const count = u16(end + 10)
  const size = u32(end + 12)
  let offset = u32(end + 16)
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) bad('不支持 ZIP64')
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count) bad('不支持分卷 ZIP')
  if (count > 2000) bad('ZIP 条目不能超过 2000 个')
  if (offset + size !== end) bad('ZIP 中央目录不合法')
  const result: { path: string; data: Uint8Array }[] = []
  let total = 0
  for (let i = 0; i < count; i++) {
    check(offset, 46)
    if (u32(offset) !== 0x02014b50) bad('ZIP 中央目录不合法')
    const flags = u16(offset + 8)
    const method = u16(offset + 10)
    const compressed = u32(offset + 20)
    const expanded = u32(offset + 24)
    const nameSize = u16(offset + 28)
    const extraSize = u16(offset + 30)
    const commentSize = u16(offset + 32)
    const local = u32(offset + 42)
    if ([compressed, expanded, local].includes(0xffffffff)) bad('不支持 ZIP64')
    if (flags & 0x41) bad('不支持加密 ZIP 条目')
    check(offset + 46, nameSize + extraSize + commentSize)
    const extraEnd = offset + 46 + nameSize + extraSize
    for (let pos = offset + 46 + nameSize; pos < extraEnd; ) {
      if (pos + 4 > extraEnd) bad('ZIP 扩展字段不完整')
      if (u16(pos) === 1) bad('不支持 ZIP64')
      pos += 4 + u16(pos + 2)
      if (pos > extraEnd) bad('ZIP 扩展字段不完整')
    }
    const name = bytes.subarray(offset + 46, offset + 46 + nameSize)
    let path: string
    try {
      path = new TextDecoder('utf-8', { fatal: true }).decode(name)
    } catch {
      if (flags & 0x800) bad('ZIP 文件名不是合法 UTF-8')
      path = Array.from(name, (value) => String.fromCharCode(value)).join('')
    }
    offset += 46 + nameSize + extraSize + commentSize
    if (offset > end) bad('ZIP 中央目录不完整')
    total += expanded
    if (expanded > 30 * MB || total > 300 * MB) bad('ZIP 解压大小超过限制')
    if (path.includes('..') || path.startsWith('/') || path.includes('\\') || path.endsWith('/')) continue
    check(local, 30)
    if (u32(local) !== 0x04034b50) bad('ZIP 本地文件头不合法')
    if (u16(local + 6) & 0x41) bad('不支持加密 ZIP 条目')
    if (u16(local + 8) !== method) bad('ZIP 压缩方式不一致')
    const start = local + 30 + u16(local + 26) + u16(local + 28)
    check(start, compressed)
    if (start + compressed > end - size) bad('ZIP 文件数据越界')
    const raw = bytes.subarray(start, start + compressed)
    let data: Uint8Array = new Uint8Array()
    if (method === 0) data = raw.slice()
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.min(30 * MB, expanded + 1) })
      } catch {
        bad('ZIP 解压失败或文件超过大小限制')
      }
    } else bad(`不支持 ZIP 压缩方式：${method}`)
    if (data.length !== expanded) bad('ZIP 文件大小与目录不一致')
    result.push({ path, data })
  }
  if (offset !== end) bad('ZIP 中央目录条目数不一致')
  return result
}
