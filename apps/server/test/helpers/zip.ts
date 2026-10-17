import { deflateRawSync } from 'node:zlib'

/** 手工写入中央目录，测试不依赖第三方压缩库。 */
export function makeZip(entries: { path: string; data: Uint8Array; method?: number; flags?: number }[]) {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path)
    const method = entry.method ?? 0
    const compressed = method === 8 ? deflateRawSync(entry.data) : Buffer.from(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.flags ?? 0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(entry.flags ?? 0x800, 8)
    directory.writeUInt16LE(method, 10)
    directory.writeUInt32LE(compressed.length, 20)
    directory.writeUInt32LE(entry.data.length, 24)
    directory.writeUInt16LE(name.length, 28)
    directory.writeUInt32LE(offset, 42)
    central.push(directory, name)
    locals.push(local, name, compressed)
    offset += local.length + name.length + compressed.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(Buffer.concat(central).length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...central, end])
}
