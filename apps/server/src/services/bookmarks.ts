import { castKey, pickSprite, toDisplayText } from '@nobot/core/stage'
import type { BookmarkDTO, CreateBookmarkInput, CreateSaveInput, MessageDTO, SaveSnapshot } from '@nobot/shared'
import { asc, eq } from 'drizzle-orm'
import { db, newId } from '../db/client'
import { bookmarks, characters } from '../db/schema'
import { HttpError, notFound } from '../errors'
import { t } from '../i18n'
import { avatarUrl } from '../lib/files'
import { backgroundsForChat, listBackgrounds } from './backgrounds/backgrounds'
import { computeVars, getChatRow, loadMessage, loadPath } from './chats'
import { resolvePersona } from './generation/context'
import { computeStage, initialVars, resolvePlayPreset, resolveStateSchema, stageMembers } from './generation/stage'
import { readableMessage } from './rooms/dto'
import { listSprites } from './sprites/sprites'

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
  const message = readableMessage(loadMessage(row.messageId))
  const persona = resolvePersona(chat)
  const character = message.speakerId
    ? db.select().from(characters).where(eq(characters.id, message.speakerId)).get()
    : undefined
  const name =
    message.role === 'user'
      ? persona.id
        ? persona.name
        : (message.meta.name ?? t('你'))
      : message.role === 'assistant'
        ? (character?.name ?? message.meta.name ?? '')
        : message.role === 'tool'
          ? (message.meta.toolName ?? '')
          : t('系统')
  const chars = Array.from(plainText(message))
  const text = chars.length
    ? chars.slice(0, 60).join('') + (chars.length > 60 ? '…' : '')
    : message.meta.images?.length || message.meta.imageGen
      ? t('（图片）')
      : ''
  return {
    ...row,
    ...(message.meta.hidden ? { name: '', snapshot: null } : {}),
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
  const message = readableMessage(loadMessage(input.messageId))
  if (message.meta.hidden) throw notFound(t('消息'))
  if (message.chatId !== chatId) throw notFound(t('消息'))
  const content = plainText(message)
  const name =
    input.name?.trim() ||
    Array.from(content).slice(0, 20).join('') ||
    t('书签 {n}', { n: db.select().from(bookmarks).where(eq(bookmarks.chatId, chatId)).all().length + 1 })
  const row: typeof bookmarks.$inferSelect = {
    id: newId(),
    chatId,
    messageId: message.id,
    name,
    kind: 'bookmark',
    snapshot: null,
    createdAt: Date.now(),
  }
  db.insert(bookmarks).values(row).run()
  return toDTO(row)
}

/** 存档只在创建时计算快照，之后编辑消息、变量和预设都不重算。 */
export function createSave(chatId: string, input: CreateSaveInput): BookmarkDTO {
  const chat = getChatRow(chatId)
  const messageId = input.messageId ?? chat.activeLeafId
  if (!messageId) throw new HttpError(400, 'NO_MESSAGES', t('还没有消息，没法存档'))
  const message = readableMessage(loadMessage(messageId))
  if (message.meta.hidden) throw notFound(t('消息'))
  if (message.chatId !== chatId) throw notFound(t('消息'))
  const path = loadPath(messageId)
  const stage = computeStage(chatId, path)
  const play = resolvePlayPreset(chatId).data
  const vars = computeVars(path, initialVars(chatId).vars)
  const members = stageMembers(chatId)
  const lastLine = message.meta.stage?.beats.findLast((beat) => beat.kind === 'line')
  const speaker = lastLine?.kind === 'line' ? castKey(lastLine.speaker) : null
  const cast = stage?.cast ?? []
  const focused = cast.find((actor) => actor.key === speaker)
  const actors = (focused ? [focused, ...cast.filter((actor) => actor !== focused)] : cast).slice(0, 3)
  const library = backgroundsForChat(chatId)
  const snapshot: SaveSnapshot = {
    backgroundUrl:
      (
        library.find((background) => background.id === stage?.scene.backgroundId) ??
        listBackgrounds().find((background) => background.id === chat.backgroundId)
      )?.url ?? null,
    actors: actors.map((actor) => {
      const character = members.find((member) => member.id === actor.characterId)
      const sprite = character
        ? pickSprite(listSprites(character.id), {
            expression: actor.expression,
            outfit: actor.outfit ?? '',
            fallback: play.sprites.fallback,
            random: play.sprites.randomMultiple,
            seed: `${messageId}:${actor.key}`,
          })
        : null
      return {
        name: actor.name,
        characterId: actor.characterId ?? null,
        spriteUrl: sprite?.url ?? null,
        avatarUrl: character ? avatarUrl(character.avatarFile, character.updatedAt) : null,
      }
    }),
    place: stage?.scene.place ?? null,
    time: stage?.scene.time ?? null,
    text: Array.from(plainText(message)).slice(0, 60).join(''),
    vars: Object.entries(resolveStateSchema(chatId, play))
      .filter(([, field]) => field.pin)
      .map(([key, field]): [string, string] => {
        const value = vars[key]
        let text = Array.isArray(value) ? value.join('、') : value == null ? '' : String(value)
        const max = typeof field.max === 'string' ? vars[field.max] : field.max
        if (field.type === 'meter' && max != null) text = `${text}/${max}`
        return [field.label ?? key, text]
      }),
  }
  const n =
    db
      .select()
      .from(bookmarks)
      .where(eq(bookmarks.chatId, chatId))
      .all()
      .filter((bookmark) => bookmark.kind === 'save').length + 1
  const name = input.name?.trim() || `${t('存档 {n}', { n })}${snapshot.place ? ` · ${snapshot.place}` : ''}`
  const row: typeof bookmarks.$inferSelect = {
    id: newId(),
    chatId,
    messageId,
    name,
    kind: 'save',
    snapshot,
    createdAt: Date.now(),
  }
  db.insert(bookmarks).values(row).run()
  return toDTO(row)
}

function requireBookmark(id: string) {
  const row = db.select().from(bookmarks).where(eq(bookmarks.id, id)).get()
  if (!row) throw notFound(t('书签'))
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
