import type { MessageDTO, RoomSessionDTO, roomSessionInput } from '@nobot/shared'
import { and, eq, gt, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { db, getSetting, newId } from '../../db/client'
import { roomEvents, roomMessageIndex } from '../../db/schema'
import { systemDatabase as system } from '../../db/system-client'
import { roomMembers, roomNotificationDeliveries, roomSessionRsvps, roomSessions } from '../../db/system-schema'
import { HttpError } from '../../errors'
import { t } from '../../i18n'
import { currentUser } from '../../user-context'
import { getChatRow, loadPath } from '../chats'
import { notify } from '../social'
import { canReadMessage, roomMessage } from './dto'
import { asHost, changed, members, membership, type Room, requireRole, roomRow, unavailable } from './index'

/** 去重记录与通知同事务写入，进程重启和定时器重复执行不会重发。 */
export function notifyRoom(room: Room, userId: string, type: string, key: string, actor: string | null = null) {
  const member = membership(room.id, userId).member
  if (member.notifyPreference === 'none' || (member.notifyPreference === 'mentions' && type !== 'room.mention')) return
  system().transaction(() => {
    const inserted = system()
      .insert(roomNotificationDeliveries)
      .values({ key, roomId: room.id, createdAt: Date.now() })
      .onConflictDoNothing()
      .returning()
      .get()
    if (inserted) notify(userId, type, actor, { roomId: room.id })
  })
}
export function notifyMentions(room: Room, message: MessageDTO) {
  if (!['ic', 'ooc'].includes(message.meta.channel ?? '')) return
  for (const m of members(room.id)) {
    if (m.userId === message.meta.author?.userId || !m.personaName.trim()) continue
    const escaped = m.personaName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`@${escaped}(?=$|[\\s,.!?，。！？:：])`, 'iu').test(message.content))
      notifyRoom(room, m.userId, 'room.mention', `mention:${message.id}:${m.userId}`, message.meta.author?.userId)
  }
}
export function visibleHistory(id: string, userId = currentUser().id) {
  const { room, member } = membership(id, userId)
  return asHost(room, () => {
    const path = loadPath(getChatRow(room.chatId).activeLeafId)
      .filter((m) => member.role !== 'spectator' || canReadMessage(m, member.userId, room.hostUserId))
      .map((m) => roomMessage(m, member.userId, room.hostUserId))
    if (member.role === 'spectator') {
      const ids = new Set(path.map((m) => m.id))
      for (const [i, m] of path.entries()) {
        m.parentId = path[i - 1]?.id ?? null
        if (m.meta.replyTo && !ids.has(m.meta.replyTo)) delete m.meta.replyTo
      }
    }
    return path
  })
}
export function unreadDetails(id: string) {
  const { room, member } = membership(id)
  return asHost(room, () => {
    const events = db.select().from(roomEvents).where(eq(roomEvents.roomId, id)).orderBy(roomEvents.seq).all()
    const created = new Map(
      db
        .select()
        .from(roomMessageIndex)
        .where(eq(roomMessageIndex.roomId, id))
        .all()
        .map((e) => [e.messageId, e.seq]),
    )
    const unread = visibleHistory(id, member.userId).filter(
      (m) => !m.meta.hidden && m.meta.author?.userId !== member.userId && (created.get(m.id) ?? 0) > member.lastReadSeq,
    )
    return { count: unread.length, firstUnreadMessageId: unread[0]?.id ?? null, latestSeq: events.at(-1)?.seq ?? 0 }
  })
}
export function markRead(id: string, seq: number) {
  const { member } = membership(id)
  const latest = unreadDetails(id).latestSeq
  system()
    .update(roomMembers)
    .set({ lastReadSeq: Math.max(member.lastReadSeq, Math.min(seq, latest)) })
    .where(and(eq(roomMembers.roomId, id), eq(roomMembers.userId, member.userId)))
    .run()
}
export function setNotify(id: string, notifyPreference: 'all' | 'mentions' | 'none') {
  const { member } = membership(id)
  system()
    .update(roomMembers)
    .set({ notifyPreference })
    .where(and(eq(roomMembers.roomId, id), eq(roomMembers.userId, member.userId)))
    .run()
  return { notifyPreference }
}
export function exportRoom(id: string, format: 'markdown' | 'json', now = Date.now()) {
  const { room, member } = membership(id)
  const recent = asHost(room, () =>
    db
      .select()
      .from(roomEvents)
      .where(
        and(
          eq(roomEvents.roomId, id),
          eq(roomEvents.type, 'room.export'),
          eq(roomEvents.actorId, member.userId),
          gt(roomEvents.createdAt, now - 60000),
        ),
      )
      .orderBy(sql`${roomEvents.seq} desc`)
      .all(),
  )
  if (recent.length >= 3) throw new HttpError(429, 'RATE_LIMITED', t('导出过于频繁，请稍后重试'))
  const rewrite = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith('/api/assets/'))
      return `/api/rooms/${encodeURIComponent(id)}/scope${v.slice(4)}`
    if (Array.isArray(v)) return v.map(rewrite)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x)]))
    return v
  }
  const history = rewrite(visibleHistory(id)) as MessageDTO[]
  const choices = asHost(room, () =>
    history
      .filter((m) => !m.meta.hidden && m.meta.stage?.choices?.length)
      .flatMap((m) => {
        const state = getSetting<import('@nobot/shared').RoomChoiceState>(`room.choice:${id}:${m.id}`)
        return state ? [state] : []
      }),
  )
  changed(room, 'room.export', member.userId, { format })
  if (format === 'json') return JSON.stringify({ roomId: id, messages: history, choices }, null, 2)
  return (
    history
      .map((m) => {
        if (m.meta.hidden) return ''
        const name = m.meta.author?.name ?? m.meta.name ?? m.role
        return `### ${name} · ${new Date(m.createdAt).toISOString()}\n\n${m.content}\n\n${JSON.stringify(m.meta, null, 2)}`
      })
      .filter(Boolean)
      .join('\n\n') + (choices.length ? `\n\n${JSON.stringify(choices, null, 2)}` : '')
  )
}
export function listSessions(id: string, userId = currentUser().id): RoomSessionDTO[] {
  membership(id, userId)
  return system()
    .select()
    .from(roomSessions)
    .where(eq(roomSessions.roomId, id))
    .orderBy(roomSessions.startsAt)
    .all()
    .map(({ remindedAt: _, ...s }) => ({
      ...s,
      myRsvp:
        system()
          .select()
          .from(roomSessionRsvps)
          .where(and(eq(roomSessionRsvps.sessionId, s.id), eq(roomSessionRsvps.userId, userId)))
          .get()?.response ?? null,
    }))
}
export function nextSession(id: string, userId: string) {
  return listSessions(id, userId).find((s) => !s.cancelledAt && s.startsAt > Date.now()) ?? null
}
export function saveSession(id: string, input: z.infer<typeof roomSessionInput>, sessionId?: string) {
  const { room } = requireRole(id, ['owner', 'gm'])
  const actor = currentUser().id
  if (input.startsAt < Date.now() - 300000)
    throw new HttpError(400, 'SESSION_IN_PAST', t('预约开始时间不能早于当前时间五分钟'))
  if (
    sessionId &&
    !system()
      .select()
      .from(roomSessions)
      .where(and(eq(roomSessions.id, sessionId), eq(roomSessions.roomId, id)))
      .get()
  )
    throw unavailable()
  const session = sessionId
    ? system()
        .update(roomSessions)
        .set({ ...input, remindedAt: null })
        .where(eq(roomSessions.id, sessionId))
        .returning()
        .get()!
    : system()
        .insert(roomSessions)
        .values({ ...input, id: newId(), roomId: id, createdBy: actor })
        .returning()
        .get()
  if (!sessionId)
    for (const m of members(id))
      notifyRoom(room, m.userId, 'room.session.created', `session-created:${session.id}:${m.userId}`, actor)
  changed(room, 'room.session', actor, { sessionId: session.id })
  resumeExtensions(room)
  return listSessions(id).find((s) => s.id === session.id)!
}
export function cancelSession(id: string, sessionId: string) {
  const { room } = requireRole(id, ['owner', 'gm'])
  system()
    .update(roomSessions)
    .set({ cancelledAt: Date.now() })
    .where(and(eq(roomSessions.roomId, id), eq(roomSessions.id, sessionId)))
    .run()
  changed(room, 'room.session', currentUser().id, { sessionId })
  resumeExtensions(room)
}
export function rsvp(id: string, sessionId: string, response: 'yes' | 'maybe' | 'no') {
  const { room, member } = membership(id)
  if (!listSessions(id).some((s) => s.id === sessionId && s.cancelledAt === null)) throw unavailable()
  system()
    .insert(roomSessionRsvps)
    .values({ sessionId, userId: member.userId, response })
    .onConflictDoUpdate({ target: [roomSessionRsvps.sessionId, roomSessionRsvps.userId], set: { response } })
    .run()
  changed(room, 'room.session', member.userId, { sessionId })
}
const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** 启动时重新扫描系统库；持久提醒标记和去重键才是事实来源，定时器只是唤醒器。 */
export function resumeExtensions(room: Room, now = Date.now()) {
  clearTimeout(timers.get(room.id))
  const pending = system()
    .select()
    .from(roomSessions)
    .where(eq(roomSessions.roomId, room.id))
    .all()
    .filter((s) => !s.cancelledAt && !s.remindedAt && s.startsAt > now)
  for (const s of pending.filter((s) => s.startsAt - 1800000 <= now)) {
    system().transaction(() => {
      for (const r of system().select().from(roomSessionRsvps).where(eq(roomSessionRsvps.sessionId, s.id)).all()) {
        if (r.response !== 'no' && members(room.id).some((m) => m.userId === r.userId))
          notifyRoom(room, r.userId, 'room.session.starting', `session-starting:${s.id}:${s.startsAt}:${r.userId}`)
      }
      system().update(roomSessions).set({ remindedAt: now }).where(eq(roomSessions.id, s.id)).run()
    })
  }
  const future = pending.filter((s) => s.startsAt - 1800000 > now)
  if (future.length) {
    const timer = setTimeout(
      () => {
        try {
          resumeExtensions(roomRow(room.id))
        } catch {
          /* 房间已删除时不再恢复。 */
        }
      },
      Math.min(2147483647, Math.max(1, Math.min(...future.map((s) => s.startsAt - 1800000)) - now)),
    )
    timer.unref()
    timers.set(room.id, timer)
  }
}
