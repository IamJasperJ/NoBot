import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { backgrounds, characters, messages } from '../db/schema'
import { thumbFile } from '../lib/files'
import { type getChatRow, loadPath } from './chats'
import { computeStage } from './generation/stage'
import { readTemporaryActors } from './sprites/temporary-actors'

export function chatAssetAllowed(chat: ReturnType<typeof getChatRow>, path: string) {
  const character = chat.characterId
    ? db.select().from(characters).where(eq(characters.id, chat.characterId)).get()
    : undefined
  if (character?.avatarFile && path === `/api/assets/avatars/${thumbFile(character.avatarFile)}`) return true
  if (character && path.startsWith(`/api/assets/sprites/${character.id}/`)) return true
  if (
    Object.values(readTemporaryActors(chat.id)).some(
      (a) => a.status !== 'removed' && a.image?.url.split('?')[0] === path,
    )
  )
    return true
  const stage = computeStage(chat.id, loadPath(chat.activeLeafId))
  const ids = [chat.backgroundId, character?.defaultBackgroundId, stage?.scene.backgroundId].filter(Boolean)
  if (
    db
      .select()
      .from(backgrounds)
      .all()
      .some(
        (b) =>
          (b.chatId === chat.id || ids.includes(b.id)) &&
          [
            `/api/assets/backgrounds/${b.id}.${b.mime.split('/')[1]}`,
            `/api/assets/backgrounds/${b.id}.thumb.webp`,
          ].includes(path),
      )
  )
    return true
  return db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chat.id))
    .all()
    .some(
      (m) =>
        m.meta.ttsCache?.some((cache) => cache.url === path) ||
        m.meta.images?.some((i) => i.url.split('?')[0] === path) ||
        m.meta.cg?.some((cg) => path === `/api/assets/attachments/${cg.attachmentId}.webp`),
    )
}
