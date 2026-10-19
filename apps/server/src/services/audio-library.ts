import { lookup } from 'node:dns/promises'
import { rm } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import {
  type AudioKind,
  type AudioTrackDTO,
  batchDeleteAudioInput,
  importAudioUrlInput,
  updateAudioTrackInput,
} from '@nobot/shared'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, newId } from '../db/client'
import { audioTracks } from '../db/schema'
import { paths } from '../env'
import { HttpError, notFound } from '../errors'
import { t } from '../i18n'

export const AUDIO_LIMIT = 30 * 1024 * 1024
const formats: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
}

export function detectAudioMime(bytes: Uint8Array): string {
  const head = Buffer.from(bytes.subarray(0, 12))
  const prefix = head.toString('ascii')
  if (prefix.startsWith('ID3') || (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0))
    return 'audio/mpeg'
  if (prefix.startsWith('OggS')) return 'audio/ogg'
  if (prefix.startsWith('RIFF') && prefix.slice(8, 12) === 'WAVE') return 'audio/wav'
  if (prefix.slice(4, 8) === 'ftyp') return 'audio/mp4'
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return 'audio/webm'
  if (prefix.startsWith('fLaC')) return 'audio/flac'
  throw new HttpError(400, 'BAD_AUDIO', t('无法识别的音频文件'))
}

function checkSize(size: number) {
  if (size > AUDIO_LIMIT) throw new HttpError(413, 'TOO_LARGE', t('文件太大（上限 {limit}MB）', { limit: 30 }))
}
function toDTO(row: typeof audioTracks.$inferSelect): AudioTrackDTO {
  return { ...row, url: `/api/assets/audio/${row.id}.${formats[row.mime]}` }
}
function requireTrack(id: string) {
  const row = db.select().from(audioTracks).where(eq(audioTracks.id, id)).get()
  if (!row) throw notFound(t('音频'))
  return row
}
export function listAudioTracks(kind?: AudioKind): AudioTrackDTO[] {
  return db
    .select()
    .from(audioTracks)
    .where(kind ? eq(audioTracks.kind, kind) : undefined)
    .orderBy(desc(audioTracks.createdAt), desc(audioTracks.id))
    .all()
    .map(toDTO)
}
export async function saveAudioTrack(
  bytes: Uint8Array,
  opts: {
    name: string
    kind: AudioKind
    description?: string
    durationMs?: number | null
  },
): Promise<AudioTrackDTO> {
  const data = updateAudioTrackInput
    .required({ name: true, kind: true })
    .extend({
      durationMs: z.number().finite().nonnegative().nullable().optional(),
    })
    .parse(opts)
  checkSize(bytes.length)
  const mime = detectAudioMime(bytes)
  const row = {
    ...data,
    id: newId(),
    description: data.description ?? '',
    mime,
    size: bytes.length,
    durationMs: data.durationMs == null ? null : Math.round(data.durationMs),
    createdAt: Date.now(),
  }
  const file = join(paths.audio, `${row.id}.${formats[mime]}`)
  try {
    await Bun.write(file, bytes)
    db.insert(audioTracks).values(row).run()
  } catch (error) {
    await rm(file, { force: true })
    throw error
  }
  return toDTO(row)
}
export function updateAudioTrack(id: string, input: z.infer<typeof updateAudioTrackInput>) {
  requireTrack(id)
  const data = updateAudioTrackInput.parse(input)
  if (!Object.values(data).some((value) => value !== undefined))
    throw new HttpError(400, 'BAD_REQUEST', t('请至少提供一个要修改的字段'))
  db.update(audioTracks).set(data).where(eq(audioTracks.id, id)).run()
  return toDTO(requireTrack(id))
}
export async function deleteAudioTrack(id: string) {
  const row = requireTrack(id)
  await rm(join(paths.audio, `${id}.${formats[row.mime]}`), { force: true })
  db.delete(audioTracks).where(eq(audioTracks.id, id)).run()
}
export async function batchDeleteAudioTracks(input: z.infer<typeof batchDeleteAudioInput>) {
  const ids = [...new Set(batchDeleteAudioInput.parse(input).ids)]
  for (const id of ids) requireTrack(id)
  for (const id of ids) await deleteAudioTrack(id)
}

/** 只接受公网地址；每次重定向都重新检查，阻止跳转到本机或内网服务。 */
function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    )
  }
  // 拒绝映射 IPv4、链路本地及特殊 IPv6，只放行全局单播地址。
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address)
}
export async function importAudioUrl(input: z.input<typeof importAudioUrlInput>): Promise<AudioTrackDTO> {
  const data = importAudioUrlInput.parse(input)
  let url = new URL(data.url)
  const signal = AbortSignal.timeout(30_000)
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'BAD_URL', t('只允许 http/https 网址'))
      const hostname = url.hostname.replace(/^\[|\]$/g, '')
      const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true })
      if (url.username || url.password || !addresses.length || addresses.some(({ address }) => !publicAddress(address)))
        throw new HttpError(400, 'BAD_URL', t('不允许访问内网地址'))
      const response = await fetch(url, { signal, redirect: 'manual' })
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        await response.body?.cancel()
        url = new URL(response.headers.get('location')!, url)
        continue
      }
      if (!response.ok || !response.body) throw new HttpError(400, 'DOWNLOAD_FAILED', t('下载音频失败或超时'))
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        checkSize(Number(response.headers.get('content-length') ?? 0))
        while (true) {
          signal.throwIfAborted()
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          checkSize(size)
          chunks.push(value)
        }
      } finally {
        await reader.cancel()
      }
      const filename = decodeURIComponent(url.pathname.split('/').pop() || '').replace(/\.[^.]+$/, '')
      return await saveAudioTrack(Buffer.concat(chunks), {
        name: data.name ?? (filename || t('音频')),
        kind: data.kind,
      })
    }
    throw new HttpError(400, 'DOWNLOAD_FAILED', t('下载音频失败或超时'))
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'DOWNLOAD_FAILED', t('下载音频失败或超时'))
  }
}
