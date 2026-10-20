import { basename, extname } from 'node:path'
import { readZip } from '../lib/zip'
import { deleteAudioTrack, listAudioTracks, saveAudioTrack } from './audio-library'

const extensions = new Set(['mp3', 'ogg', 'wav', 'm4a', 'flac', 'webm'])

/** 只导入卡内资源；普通 V3 JSON/PNG 也支持 data URI，不下载不可信外链。 */
export async function importCharacterAudio(bytes: Uint8Array, raw: Record<string, unknown>) {
  const data = raw.data
  const assets = data && typeof data === 'object' && 'assets' in data && Array.isArray(data.assets) ? data.assets : []
  const entries = bytes[0] === 0x50 && bytes[1] === 0x4b ? readZip(bytes) : []
  const created: string[] = []
  const names = new Set(listAudioTracks().map((track) => track.name.toLowerCase()))
  try {
    for (const asset of assets) {
      if (!asset || typeof asset !== 'object' || typeof asset.uri !== 'string') continue
      const path = /^(?:embeded|embedded):\/\/(.+)$/.exec(asset.uri)?.[1]
      const extension = extname(path ?? asset.uri)
        .slice(1)
        .toLowerCase()
      const declared = typeof asset.ext === 'string' ? asset.ext.replace(/^\./, '').toLowerCase() : ''
      if (!extensions.has(extension) && !extensions.has(declared)) continue
      const encoded = /^data:audio\/[\w.+-]+;base64,(.+)$/s.exec(asset.uri)?.[1]
      const content = path
        ? entries.find((entry) => entry.path === path)?.data
        : encoded
          ? Buffer.from(encoded, 'base64')
          : undefined
      if (!content) continue
      const base = (
        typeof asset.name === 'string' && asset.name.trim()
          ? asset.name.trim()
          : basename(path ?? 'audio', extname(path ?? ''))
      ).slice(0, 80)
      let name = base
      let suffix = 2
      while (names.has(name.toLowerCase())) {
        const tail = ` (${suffix++})`
        name = base.slice(0, 80 - tail.length) + tail
      }
      // 只匹配英文单词或分隔符边界，避免把 sunset、season 等普通曲名里的 se 误判成音效。
      const kind = /(?:^|[^a-z])(?:sfx|sound|se)(?:[^a-z]|$)/i.test(`${base} ${path ?? ''}`) ? 'sfx' : 'bgm'
      const track = await saveAudioTrack(content, { name, kind })
      names.add(name.toLowerCase())
      created.push(track.id)
    }
    return created
  } catch (error) {
    await Promise.all(created.map((id) => deleteAudioTrack(id)))
    throw error
  }
}
