import type { AttachmentDTO, TemporaryActorDTO } from '@nobot/shared'
import { eq } from 'drizzle-orm'
import { db, getSetting, setSetting } from '../../db/client'
import { settings } from '../../db/schema'
import { getChatRow } from '../chats'

export type TemporaryActorRecord = TemporaryActorDTO & { original?: AttachmentDTO }
const temporaryActorsKey = (chatId: string) => `vn-actors:${chatId}`

/** 旧版附件在读取时适配，下一次写入时一并升级，避免舞台依赖扩展。 */
export function readTemporaryActors(chatId: string): Record<string, TemporaryActorRecord> {
  const stored = getSetting<Record<string, TemporaryActorRecord | AttachmentDTO>>(temporaryActorsKey(chatId)) ?? {}
  return Object.fromEntries(
    Object.entries(stored)
      .filter(([, value]) => value && typeof value === 'object')
      .map(([key, value]) => [
        key,
        'id' in value && 'url' in value
          ? { key, name: key, image: value, prompt: '', status: 'done', updatedAt: 0 }
          : value,
      ]),
  )
}

/** 每次更新都合并最新设置，避免不同演员的异步任务相互覆盖。 */
export function writeTemporaryActor(chatId: string, key: string, record: TemporaryActorRecord | null) {
  getChatRow(chatId)
  const records = readTemporaryActors(chatId)
  if (record) Object.defineProperty(records, key, { value: record, enumerable: true, configurable: true })
  else delete records[key]
  setSetting(temporaryActorsKey(chatId), records)
}

/** 在删除会话的事务中取出附件并解除引用，提交后再检查是否可以删文件。 */
export function deleteTemporaryActors(chatId: string): Set<string> {
  const ids = new Set<string>()
  for (const { image, original } of Object.values(readTemporaryActors(chatId))) {
    if (image?.id) ids.add(image.id)
    if (original?.id) ids.add(original.id)
  }
  db.delete(settings)
    .where(eq(settings.key, temporaryActorsKey(chatId)))
    .run()
  return ids
}
