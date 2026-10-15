/**
 * PNG 文本块读写。
 *
 * PNG 文件 = 8 字节签名 + 一串 chunk。每个 chunk 的结构：
 *   长度(4 字节，大端) + 类型(4 字节 ASCII) + 数据 + CRC32(4 字节)
 * 酒馆把角色卡 JSON 做 base64 后，存在 tEXt chunk 里：
 *   V2 卡的关键字是 "chara"，V3 卡是 "ccv3"。
 */

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

export function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

interface Chunk {
  type: string
  data: Uint8Array
}

function readChunks(bytes: Uint8Array): Chunk[] {
  if (!isPng(bytes)) throw new Error('不是有效的 PNG 文件')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunks: Chunk[] = []
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    chunks.push({ type, data })
    offset += 12 + length
    if (type === 'IEND') break
  }
  return chunks
}

const latin1 = new TextDecoder('latin1')
const utf8 = new TextDecoder('utf-8')

/**
 * 读出 PNG 里所有文本块，返回 关键字(小写) → 文本。
 * 支持 tEXt 和未压缩的 iTXt。
 */
export function readPngTextChunks(bytes: Uint8Array): Map<string, string> {
  const result = new Map<string, string>()
  for (const chunk of readChunks(bytes)) {
    if (chunk.type === 'tEXt') {
      const sep = chunk.data.indexOf(0)
      if (sep < 0) continue
      const key = latin1.decode(chunk.data.subarray(0, sep)).toLowerCase()
      result.set(key, latin1.decode(chunk.data.subarray(sep + 1)))
    } else if (chunk.type === 'iTXt') {
      // 关键字\0 压缩标志 压缩方法 语言标签\0 翻译关键字\0 文本
      const d = chunk.data
      const sep = d.indexOf(0)
      if (sep < 0 || d[sep + 1] !== 0) continue // 跳过压缩过的 iTXt
      const langEnd = d.indexOf(0, sep + 3)
      const transEnd = d.indexOf(0, langEnd + 1)
      if (langEnd < 0 || transEnd < 0) continue
      const key = latin1.decode(d.subarray(0, sep)).toLowerCase()
      result.set(key, utf8.decode(d.subarray(transEnd + 1)))
    }
  }
  return result
}

// ---- 写入（导出角色卡时用） ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const b of bytes) crc = (CRC_TABLE[(crc ^ b) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function encodeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  const typeBytes = new TextEncoder().encode(type)
  out.set(typeBytes, 4)
  out.set(data, 8)
  // CRC 覆盖 类型 + 数据
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/**
 * 写入（或替换）一组 tEXt 块，返回新的 PNG 字节。
 * 文本必须是 latin1 范围内的字符，角色卡用 base64 所以没问题。
 */
export function writePngTextChunks(bytes: Uint8Array, entries: Record<string, string>): Uint8Array {
  const keys = new Set(Object.keys(entries).map((k) => k.toLowerCase()))
  const parts: Uint8Array[] = [new Uint8Array(PNG_SIGNATURE)]

  for (const chunk of readChunks(bytes)) {
    if (chunk.type === 'tEXt') {
      const sep = chunk.data.indexOf(0)
      const key = latin1.decode(chunk.data.subarray(0, Math.max(sep, 0))).toLowerCase()
      if (keys.has(key)) continue // 旧的同名块丢掉
    }
    if (chunk.type === 'IEND') {
      // 新文本块插在 IEND 前面
      for (const [key, text] of Object.entries(entries)) {
        const data = new Uint8Array(key.length + 1 + text.length)
        for (let i = 0; i < key.length; i++) data[i] = key.charCodeAt(i)
        for (let i = 0; i < text.length; i++) data[key.length + 1 + i] = text.charCodeAt(i)
        parts.push(encodeChunk('tEXt', data))
      }
    }
    parts.push(encodeChunk(chunk.type, chunk.data))
  }

  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}
