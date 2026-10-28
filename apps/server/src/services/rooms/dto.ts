import { AsyncLocalStorage } from 'node:async_hooks'
import type { MessageDTO } from '@nobot/shared'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { roomMessageIndex } from '../../db/schema'
import { systemDatabase } from '../../db/system-client'
import { roomMembers, rooms } from '../../db/system-schema'
import { t } from '../../i18n'
import { currentUser } from '../../user-context'

/** 角色卡原始 PNG 可能含私有文本，封面也统一使用无卡片数据的缩略图。 */
export function roomCover(asset: string | null) {
  return asset?.startsWith('/api/assets/avatars/') ? asset.replace(/\.png(?=\?|$)/, '.webp') : asset
}

/** 私密内容以消息受众为准，房主身份不能绕过作者和收件人的限制。 */
export function canReadMessage(
  message: Pick<MessageDTO, 'meta'> & Partial<Pick<MessageDTO, 'chatId' | 'createdAt' | 'id'>>,
  viewerId: string,
  _hostId?: string,
) {
  if (message.chatId) {
    const room = systemDatabase().select().from(rooms).where(eq(rooms.chatId, message.chatId)).get()
    const member = room
      ? systemDatabase()
          .select()
          .from(roomMembers)
          .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, viewerId)))
          .get()
      : undefined
    if (member?.role === 'spectator') {
      if (message.meta.channel === 'whisper' || (message.meta.visibility && message.meta.visibility.level !== 'public'))
        return false
      if (room?.spectatorHistory === 'since-join') {
        const entry = message.id
          ? db
              .select()
              .from(roomMessageIndex)
              .where(and(eq(roomMessageIndex.roomId, room.id), eq(roomMessageIndex.messageId, message.id)))
              .get()
          : undefined
        if (entry ? entry.seq <= member.joinedSeq : (message.createdAt ?? 0) < member.joinedAt) return false
      }
    }
  }
  if (message.meta.visibility?.level === 'self') return message.meta.author?.userId === viewerId
  return (
    !message.meta.visibility ||
    message.meta.visibility.level === 'public' ||
    message.meta.visibility.userIds.includes(viewerId)
  )
}

export function roomMessage(message: MessageDTO, viewerId?: string, hostId?: string): MessageDTO {
  if (viewerId && hostId && !canReadMessage(message, viewerId, hostId)) {
    // 保留消息树节点和分页游标，清掉所有可能携带私密内容的元数据。
    const blindAuthor = message.meta.visibility?.level === 'blind' && message.meta.author?.userId === viewerId
    return {
      ...message,
      content: blindAuthor ? t('已掷骰，结果隐藏') : '',
      speakerId: null,
      meta: { hidden: { reason: message.meta.channel === 'whisper' ? 'whisper' : 'blind' } },
    }
  }
  const { logId: _logId, lore: _lore, edits, ...meta } = message.meta
  const owner =
    viewerId && edits && message.chatId
      ? systemDatabase().select().from(rooms).where(eq(rooms.chatId, message.chatId)).get()?.hostUserId
      : undefined
  // 修订只给作者和房主；主持也不能借管理权限阅读他人的旧私信。
  const canReadEdits = viewerId && (viewerId === message.meta.author?.userId || viewerId === owner)
  return { ...message, meta: { ...meta, ...(canReadEdits && edits ? { edits } : {}) } }
}

/** 持久事件和临时增量采用同一裁剪，避免刷新页面与实时接收的权限不同。 */
export function roomPayload(payload: Record<string, unknown>, viewerId?: string, hostId?: string) {
  const result = { ...payload }
  for (const key of ['message', 'assistantMessage', 'userMessage']) {
    const value = result[key]
    if (value && typeof value === 'object' && 'meta' in value && 'chatId' in value)
      result[key] = roomMessage(value as MessageDTO, viewerId, hostId)
  }
  return result
}

// 转入房主数据库后仍保留实际阅读者，供普通接口和扩展的输出检查使用。
const viewers = new AsyncLocalStorage<string>()
export function asRoomViewer<T>(viewerId: string, fn: () => T): T {
  return viewers.run(viewerId, fn)
}
export function readableMessage(message: MessageDTO): MessageDTO {
  const viewerId = viewers.getStore() ?? currentUser().id
  const room = systemDatabase().select().from(rooms).where(eq(rooms.chatId, message.chatId)).get()
  return room ? roomMessage(message, viewerId, room.hostUserId) : message
}
