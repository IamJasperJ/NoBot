import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type BackgroundDTO,
  type BackgroundSettings,
  backgroundSettingsInput,
  type UpdateBackgroundInput,
  updateBackgroundInput,
} from '@ai-parter/shared'
import { desc, eq, isNull, or } from 'drizzle-orm'
import sharp from 'sharp'
import { db, getSetting, newId, setSetting } from '../db/client'
import { backgrounds } from '../db/schema'
import { paths } from '../env'
import { HttpError, notFound } from '../errors'
import { t } from '../i18n'
import { SETTING_KEYS } from './settings'

function toDTO(row: typeof backgrounds.$inferSelect): BackgroundDTO {
  return {
    ...row,
    animated: row.mime !== 'image/webp',
    url: `/api/assets/backgrounds/${row.id}.${extension(row.mime)}`,
    thumbUrl: row.mime.startsWith('video/')
      ? `/api/assets/backgrounds/${row.id}.${extension(row.mime)}`
      : `/api/assets/backgrounds/${row.id}.thumb.webp`,
  }
}

export function requireBackground(id: string) {
  const row = db.select().from(backgrounds).where(eq(backgrounds.id, id)).get()
  if (!row) throw notFound(t('背景'))
  return row
}

export function listBackgrounds(): BackgroundDTO[] {
  return db.select().from(backgrounds).orderBy(desc(backgrounds.createdAt), desc(backgrounds.id)).all().map(toDTO)
}

/** 舞台与模型只看公共背景及当前会话的背景。 */
export function backgroundsForChat(chatId: string): BackgroundDTO[] {
  return db
    .select()
    .from(backgrounds)
    .where(or(isNull(backgrounds.chatId), eq(backgrounds.chatId, chatId)))
    .orderBy(desc(backgrounds.createdAt), desc(backgrounds.id))
    .all()
    .map(toDTO)
}

/** 上传与图片生成共用此入口，持久化尺寸以旋转、缩放后的文件为准。 */
export async function saveBackground(
  bytes: Uint8Array,
  opts: { name: string; source: 'upload' | 'generated'; chatId?: string; description?: string },
): Promise<BackgroundDTO> {
  const { name, description = '' } = updateBackgroundInput.required({ name: true }).parse({
    name: opts.name,
    description: opts.description,
  })
  const mime = detectBackgroundMime(bytes)
  checkBackgroundSize(bytes.length, mime)
  let original: Uint8Array = bytes
  let thumb: Buffer | undefined
  let width = 0
  let height = 0
  try {
    if (mime === 'image/gif') {
      const metadata = await sharp(bytes).metadata()
      width = metadata.width ?? 0
      height = metadata.height ?? 0
      thumb = await sharp(bytes).resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp().toBuffer()
    } else if (!mime.startsWith('video/')) {
      const result = await sharp(bytes)
        .rotate()
        .resize(3840, 3840, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 90 })
        .toBuffer({ resolveWithObject: true })
      original = result.data
      width = result.info.width
      height = result.info.height
      thumb = await sharp(original).resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp().toBuffer()
    }
  } catch {
    throw new HttpError(400, 'BAD_IMAGE', t('无法识别的图片文件'))
  }
  const row = {
    id: newId(),
    name,
    description,
    chatId: opts.chatId ?? null,
    width,
    height,
    source: opts.source,
    mime,
    createdAt: Date.now(),
  }
  const files = [
    join(paths.backgrounds, `${row.id}.${extension(row.mime)}`),
    join(paths.backgrounds, `${row.id}.thumb.webp`),
  ]
  try {
    await Bun.write(files[0]!, original)
    if (thumb) await Bun.write(files[1]!, thumb)
    db.insert(backgrounds).values(row).run()
  } catch (error) {
    await Promise.all(files.map((file) => rm(file, { force: true })))
    throw error
  }
  return toDTO(row)
}

export function updateBackground(id: string, input: UpdateBackgroundInput): BackgroundDTO {
  requireBackground(id)
  const parsed = updateBackgroundInput.parse(input)
  if (!Object.values(parsed).some((value) => value !== undefined)) {
    throw new HttpError(400, 'BAD_REQUEST', t('请至少提供一个要修改的字段'))
  }
  db.update(backgrounds).set(parsed).where(eq(backgrounds.id, id)).run()
  return toDTO(requireBackground(id))
}

export async function deleteBackground(id: string) {
  requireBackground(id)
  await Promise.all(
    ['webp', 'thumb.webp', 'gif', 'mp4', 'webm'].map((suffix) =>
      rm(join(paths.backgrounds, `${id}.${suffix}`), { force: true }),
    ),
  )
  db.transaction(() => {
    if (getBackgroundSettings().globalId === id) setSetting(SETTING_KEYS.backgrounds, { globalId: null })
    db.delete(backgrounds).where(eq(backgrounds.id, id)).run()
  })
}

export function getBackgroundSettings(): BackgroundSettings {
  return backgroundSettingsInput.parse(getSetting(SETTING_KEYS.backgrounds) ?? { globalId: null })
}

export function setBackgroundSettings(input: unknown): BackgroundSettings {
  const parsed = backgroundSettingsInput.parse(input)
  if (parsed.globalId !== null) requireBackground(parsed.globalId)
  setSetting(SETTING_KEYS.backgrounds, parsed)
  return parsed
}

function extension(mime: string): string {
  return mime.split('/')[1] ?? 'webp'
}

/** 动态格式按文件头识别，不信任上传声明的 MIME 或文件名。 */
export function detectBackgroundMime(bytes: Uint8Array): string {
  const head = Buffer.from(bytes.subarray(0, 12))
  if (['GIF87a', 'GIF89a'].includes(head.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (head.length >= 8 && head.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4'
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm'
  return 'image/webp'
}

export function checkBackgroundSize(size: number, mime: string) {
  const limit = mime.startsWith('video/') ? 100 : 20
  if (size > limit * 1024 * 1024) throw new HttpError(413, 'TOO_LARGE', t('文件太大（上限 {limit}MB）', { limit }))
}

/** 下载时逐块限流，避免缺少 Content-Length 的响应无限占用内存。 */
export async function importBackgroundUrl(input: { url: string; name?: string }): Promise<BackgroundDTO> {
  const url = new URL(input.url)
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'BAD_URL', t('只允许 http/https 网址'))
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok || !response.body) throw new HttpError(400, 'DOWNLOAD_FAILED', t('下载背景失败'))
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    let prefix = new Uint8Array()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.length
        if (prefix.length < 12) prefix = Buffer.concat([prefix, value.subarray(0, 12 - prefix.length)])
        checkBackgroundSize(size, prefix.length >= 12 ? detectBackgroundMime(prefix) : 'video/mp4')
        chunks.push(value)
      }
    } finally {
      await reader.cancel()
    }
    const filename = decodeURIComponent(url.pathname.split('/').pop() || t('网址背景')).replace(/\.[^.]+$/, '')
    return await saveBackground(Buffer.concat(chunks), {
      name: input.name ?? (filename || t('网址背景')),
      source: 'upload',
    })
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'DOWNLOAD_FAILED', t('下载背景失败或超时'))
  }
}
