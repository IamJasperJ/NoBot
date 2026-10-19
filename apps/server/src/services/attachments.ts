import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AttachmentDTO, CharacterCgDTO, ChatMessage } from '@nobot/shared'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { decodeTime, ulid } from 'ulid'
import { db } from '../db/client'
import { chats, messages } from '../db/schema'
import { paths } from '../env'
import { HttpError } from '../errors'
import { t } from '../i18n'

const validId = (id: string) => /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id)
const imagePath = (id: string) => join(paths.attachments, `${id}.webp`)

/** 尺寸单独持久化，重启后仍能返回上传原图的宽高。 */
export async function saveAttachment(bytes: Uint8Array): Promise<AttachmentDTO> {
  let buffer: Buffer
  let width: number
  let height: number
  try {
    const metadata = await sharp(bytes).metadata()
    if (!metadata.width || !metadata.height) throw new Error(t('图片格式不支持'))
    width = metadata.width
    height = metadata.height
    buffer = await sharp(bytes)
      .rotate()
      .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
      .webp()
      .toBuffer()
  } catch {
    throw new HttpError(400, 'BAD_IMAGE', t('无法识别的图片文件'))
  }
  const id = ulid()
  const attachment = { id, url: `/api/assets/attachments/${id}.webp`, width, height }
  await Bun.write(imagePath(id), buffer)
  await Bun.write(join(paths.attachments, `${id}.json`), JSON.stringify(attachment))
  return attachment
}

/** 生成入口同步检查全部附件，校验失败时不得插入用户消息。 */
export function getAttachment(id: string): AttachmentDTO {
  if (!validId(id)) throw new HttpError(400, 'BAD_ATTACHMENT', t('图片附件不存在'))
  try {
    if (!statSync(imagePath(id)).isFile()) throw new Error(t('图片文件缺失'))
    const data: unknown = JSON.parse(readFileSync(join(paths.attachments, `${id}.json`), 'utf8'))
    if (
      !data ||
      typeof data !== 'object' ||
      !('width' in data) ||
      !('height' in data) ||
      typeof data.width !== 'number' ||
      typeof data.height !== 'number'
    )
      throw new Error(t('图片尺寸缺失'))
    return {
      id,
      url: `/api/assets/attachments/${id}.webp`,
      width: data.width,
      height: data.height,
      ...('isCg' in data && typeof data.isCg === 'boolean' ? { isCg: data.isCg } : {}),
      ...('caption' in data && typeof data.caption === 'string' ? { caption: data.caption } : {}),
    }
  } catch {
    throw new HttpError(400, 'BAD_ATTACHMENT', t('图片附件不存在'))
  }
}

export async function setAttachmentCaption(id: string, caption: string): Promise<AttachmentDTO> {
  return updateAttachment(id, { caption })
}

export async function setAttachmentCg(id: string, isCg: boolean): Promise<AttachmentDTO> {
  return updateAttachment(id, { isCg })
}

async function updateAttachment(
  id: string,
  patch: Partial<Pick<AttachmentDTO, 'caption' | 'isCg'>>,
): Promise<AttachmentDTO> {
  const attachment = { ...getAttachment(id), ...patch }
  await Bun.write(join(paths.attachments, `${id}.json`), JSON.stringify(attachment))
  db.transaction(() => {
    for (const row of db.select().from(messages).all()) {
      if (!row.meta.images?.some((image) => image.id === id)) continue
      db.update(messages)
        .set({
          meta: {
            ...row.meta,
            images: row.meta.images.map((image) => (image.id === id ? { ...image, ...patch } : image)),
          },
        })
        .where(eq(messages.id, row.id))
        .run()
    }
  })
  return attachment
}

const imageCache = new Map<string, string>()

/** 缓存仅保留最近使用的 50 个「附件 + 尺寸」，避免长会话持续占用内存。 */
export async function resolveImages(messages: ChatMessage[], maxSize: number): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  for (const id of new Set(messages.flatMap((message) => message.images ?? []))) {
    getAttachment(id)
    const key = `${id}:${maxSize}`
    let url = imageCache.get(key)
    if (!url) {
      const buffer = await sharp(imagePath(id))
        .resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
        .webp()
        .toBuffer()
      url = `data:image/webp;base64,${buffer.toString('base64')}`
    }
    imageCache.delete(key)
    imageCache.set(key, url)
    if (imageCache.size > 50) imageCache.delete(imageCache.keys().next().value!)
    result.set(id, url)
  }
  return result
}

/** 日志保留多模态结构和附件标识，不保存体积庞大的 base64。 */
export function redactImages(body: Record<string, unknown>, images: Map<string, string>): Record<string, unknown> {
  const ids = new Map([...images].map(([id, url]) => [url, t('[图片 {id}]', { id })]))
  return JSON.parse(
    JSON.stringify(body, (_key, value: unknown) => (typeof value === 'string' ? (ids.get(value) ?? value) : value)),
  ) as Record<string, unknown>
}

/** 单聊归会话角色，群聊严格按发言者归属；包含分支中已经解锁的 CG。 */
export function characterCgs(characterId: string): CharacterCgDTO[] {
  const owners = new Map(
    db
      .select()
      .from(chats)
      .all()
      .map((chat) => [chat.id, chat]),
  )
  return db
    .select()
    .from(messages)
    .all()
    .filter((message) => {
      const chat = owners.get(message.chatId)
      return chat && (chat.groupId ? message.speakerId === characterId : chat.characterId === characterId)
    })
    .flatMap((message) =>
      (message.meta.images ?? [])
        .filter((image) => image.isCg)
        .map((image) => {
          let createdAt = message.createdAt
          try {
            createdAt = decodeTime(image.id)
          } catch {
            /* 非 ULID 的历史附件使用消息时间。 */
          }
          return { ...image, chatId: message.chatId, messageId: message.id, createdAt }
        }),
    )
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
}
