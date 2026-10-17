import { toDisplayText } from '@ai-parter/core/stage'
import type { BookmarkDTO, CreateBookmarkInput, MessageDTO } from '@ai-parter/shared'
import { asc, eq } from 'drizzle-orm'
import { db, newId } from '../db/client'
import { bookmarks, characters } from '../db/schema'
import { notFound } from '../errors'
import { getChatRow, loadMessage, loadPath } from './chats'
import { resolvePersona } from './context'

/** 摘要和默认名用的纯文字：角色回复先去掉舞台指令（<scene>、<state> 等标签和台词速记），再把换行压成空格 */
const plainText = (message: MessageDTO) =>
  (message.role === 'assistant'
    ? toDisplayText(message.content, { knownNames: [], narratorNames: [], speaker: 'plain' })
    : message.content
  )
    .trim()
    .replace(/\s*[\r\n]+\s*/g, ' ')

function toDTO(row: typeof bookmarks.$inferSelect): BookmarkDTO {
  const chat = getChatRow(row.chatId)
  const message = loadMessage(row.messageId)
  const persona = resolvePersona(chat)
  const character = message.speakerId
    ? db.select().from(characters).where(eq(characters.id, message.speakerId)).get()
    : undefined
  const name =
    message.role === 'user'
      ? persona.id
        ? persona.name
        : (message.meta.name ?? '你')
      : message.role === 'assistant'
        ? (character?.name ?? message.meta.name ?? '')
        : message.role === 'tool'
          ? (message.meta.toolName ?? '')
          : '系统'
  const chars = Array.from(plainText(message))
  const text = chars.length
    ? chars.slice(0, 60).join('') + (chars.length > 60 ? '…' : '')
    : message.meta.images?.length || message.meta.imageGen
      ? '（图片）'
      : ''
  return {
    ...row,
    preview: { role: message.role, name, text },
    onPath: loadPath(chat.activeLeafId).some((m) => m.id === message.id),
  }
}

export function listBookmarks(chatId: string): BookmarkDTO[] {
  getChatRow(chatId)
  return db
    .select()
    .from(bookmarks)
    .where(eq(bookmarks.chatId, chatId))
    .orderBy(asc(bookmarks.createdAt))
    .all()
    .map(toDTO)
}

export function createBookmark(chatId: string, input: CreateBookmarkInput): BookmarkDTO {
  getChatRow(chatId)
  const message = loadMessage(input.messageId)
  if (message.chatId !== chatId) throw notFound('消息')
  const content = plainText(message)
  const name =
    input.name?.trim() ||
    Array.from(content).slice(0, 20).join('') ||
    `书签 ${db.select().from(bookmarks).where(eq(bookmarks.chatId, chatId)).all().length + 1}`
  const row = { id: newId(), chatId, messageId: message.id, name, createdAt: Date.now() }
  db.insert(bookmarks).values(row).run()
  return toDTO(row)
}

function requireBookmark(id: string) {
  const row = db.select().from(bookmarks).where(eq(bookmarks.id, id)).get()
  if (!row) throw notFound('书签')
  return row
}

export function renameBookmark(id: string, name: string): BookmarkDTO {
  const row = requireBookmark(id)
  db.update(bookmarks).set({ name }).where(eq(bookmarks.id, id)).run()
  return toDTO({ ...row, name })
}

export function deleteBookmark(id: string) {
  requireBookmark(id)
  db.delete(bookmarks).where(eq(bookmarks.id, id)).run()
}
