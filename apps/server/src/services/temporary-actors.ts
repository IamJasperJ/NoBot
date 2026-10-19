import type { AttachmentDTO, TemporaryActorDTO } from '@nobot/shared'
import { getSetting, setSetting } from '../db/client'

/** 旧版附件在读取时适配，下一次写入时一并升级，避免舞台依赖扩展。 */
export function readTemporaryActors(chatId: string): Record<string, TemporaryActorDTO> {
  const stored = getSetting<Record<string, TemporaryActorDTO | AttachmentDTO>>(`vn-actors:${chatId}`) ?? {}
  return Object.fromEntries(
    Object.entries(stored).map(([key, value]) => [
      key,
      'id' in value && 'url' in value
        ? { key, name: key, image: value, prompt: '', status: 'done', updatedAt: 0 }
        : value,
    ]),
  )
}

/** 每次更新都合并最新设置，避免不同演员的异步任务相互覆盖。 */
export function writeTemporaryActor(chatId: string, key: string, record: TemporaryActorDTO | null) {
  const records = readTemporaryActors(chatId)
  if (record) Object.defineProperty(records, key, { value: record, enumerable: true, configurable: true })
  else delete records[key]
  setSetting(`vn-actors:${chatId}`, records)
}
