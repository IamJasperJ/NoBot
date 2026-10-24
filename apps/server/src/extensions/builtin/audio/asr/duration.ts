import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let probe: string | null | undefined
/** 优先读本地容器的真实时长；ffprobe 与 Docker 中的 ffmpeg 一起安装。 */
export async function audioDuration(bytes: Uint8Array): Promise<number | undefined> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') {
    let rate = 0
    let size = 0
    for (let at = 12; at + 8 <= buffer.length; ) {
      const name = buffer.toString('ascii', at, at + 4)
      const length = buffer.readUInt32LE(at + 4)
      if (name === 'fmt ' && length >= 16 && at + 24 <= buffer.length) rate = buffer.readUInt32LE(at + 16)
      if (name === 'data') size += Math.min(length, buffer.length - at - 8)
      at += 8 + length + (length % 2)
    }
    if (rate) return Math.round((size / rate) * 1000)
  }
  if (buffer.toString('ascii', 0, 4) === 'OggS' && buffer.includes(Buffer.from('OpusHead'))) {
    let granule = 0
    for (let at = 0; at + 27 <= buffer.length; ) {
      if (buffer.toString('ascii', at, at + 4) !== 'OggS') break
      const value = buffer.readBigUInt64LE(at + 6)
      if (value !== 0xffffffffffffffffn) granule = Math.max(granule, Number(value))
      const segments = buffer[at + 26]!
      if (at + 27 + segments > buffer.length) break
      let length = 27 + segments
      for (let i = 0; i < segments; i++) length += buffer[at + 27 + i]!
      at += length
    }
    if (granule) return Math.round(granule / 48)
  }
  if (probe === undefined) probe = Bun.which('ffprobe')
  if (!probe) return undefined
  const directory = await mkdtemp(join(tmpdir(), 'nobot-asr-'))
  try {
    const file = join(directory, 'audio')
    await Bun.write(file, bytes)
    const child = Bun.spawn(
      [probe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
      { stdout: 'pipe', stderr: 'ignore' },
    )
    const timer = setTimeout(() => child.kill(), 10000)
    try {
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
      const seconds = Number(output.trim())
      return code === 0 && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return undefined
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
