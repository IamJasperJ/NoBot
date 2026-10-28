import type { FriendsDTO, NotificationDTO, PublicUserDTO } from '@nobot/shared'
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { systemDatabase as db } from '../../db/system-client'
import { userBlocks as b, friendships as f, notifications as n, users } from '../../db/system-schema'
import { HttpError } from '../../errors'
import { t } from '../../i18n'
import { liveHub } from '../live/hub'
import { presence } from './presence'

const denied = () => new HttpError(400, 'SOCIAL_REFUSED', t('无法完成此社交操作'))
export const publicUser = (u: PublicUserDTO): PublicUserDTO => ({ id: u.id, handle: u.handle, name: u.name })
const pair = (a: string, b: string) => (a < b ? { userA: a, userB: b } : { userA: b, userB: a })
const wherePair = (a: string, b: string) => {
  const p = pair(a, b)
  return and(eq(f.userA, p.userA), eq(f.userB, p.userB))
}
export function blocked(a: string, c: string) {
  return !!db()
    .select()
    .from(b)
    .where(or(and(eq(b.blockerId, a), eq(b.blockedId, c)), and(eq(b.blockerId, c), eq(b.blockedId, a))))
    .get()
}
export function friendIds(id: string) {
  if (db().select().from(users).where(eq(users.id, id)).get()?.kind === 'external') return []
  return db()
    .select()
    .from(f)
    .where(and(eq(f.status, 'accepted'), or(eq(f.userA, id), eq(f.userB, id))))
    .all()
    .map((r) => (r.userA === id ? r.userB : r.userA))
    .filter(
      (other) =>
        !blocked(id, other) &&
        !!db()
          .select()
          .from(users)
          .where(and(eq(users.id, other), eq(users.disabled, false), eq(users.kind, 'normal')))
          .get(),
    )
}
export function findUserByHandle(handle: string, viewer: string) {
  const row = db()
    .select()
    .from(users)
    .where(
      and(sql`lower(${users.handle}) = ${handle.toLowerCase()}`, eq(users.disabled, false), eq(users.kind, 'normal')),
    )
    .get()
  return !row ||
    db()
      .select()
      .from(b)
      .where(and(eq(b.blockerId, row.id), eq(b.blockedId, viewer)))
      .get()
    ? null
    : publicUser(row)
}
const dto = (row: typeof n.$inferSelect): NotificationDTO => ({ ...row, id: String(row.id) })
export function unreadCount(id: string) {
  return db()
    .select({ count: sql<number>`count(*)` })
    .from(n)
    .where(and(eq(n.userId, id), isNull(n.readAt), isNull(n.dismissedAt)))
    .get()!.count
}
const notificationListeners = new Set<(userId: string, type: string, payload: Record<string, unknown>) => void>()
/** 外部成员没有网页收件箱，渠道可订阅相同的已去重房间通知。 */
export function subscribeSocialNotifications(
  listener: (userId: string, type: string, payload: Record<string, unknown>) => void,
) {
  notificationListeners.add(listener)
  return () => notificationListeners.delete(listener)
}
export function notify(
  userId: string,
  type: string,
  actorId: string | null,
  payload: Record<string, unknown> = {},
  now = Date.now(),
) {
  for (const listener of notificationListeners) {
    try {
      listener(userId, type, payload)
    } catch {
      /* 渠道不能阻断持久通知。 */
    }
  }
  if (db().select().from(users).where(eq(users.id, userId)).get()?.kind === 'external') return undefined
  // 附上发起人的公开资料，界面不用再逐条查询；只放 id、handle、名字
  const actor = actorId ? db().select().from(users).where(eq(users.id, actorId)).get() : undefined
  if (actor && payload.actor === undefined) payload = { ...payload, actor: publicUser(actor) }
  const data = dto(db().insert(n).values({ userId, type, actorId, payload, createdAt: now }).returning().get())
  liveHub.publishToUser(userId, { type: 'notification', topic: `user:${userId}`, id: data.id, data })
  return data
}
export function listNotifications(id: string, before?: string, limit = 50) {
  const rows = db()
    .select()
    .from(n)
    .where(and(eq(n.userId, id), isNull(n.dismissedAt), before ? lt(n.id, Number(before)) : undefined))
    .orderBy(desc(n.id))
    .limit(limit + 1)
    .all()
  return { items: rows.slice(0, limit).map(dto), nextCursor: rows.length > limit ? String(rows[limit - 1]!.id) : null }
}
export function replayNotifications(id: string, cursor: string) {
  return db()
    .select()
    .from(n)
    .where(and(eq(n.userId, id), gt(n.id, Number(cursor))))
    .orderBy(n.id)
    .limit(201)
    .all()
    .map(dto)
}
export function latestNotificationCursor(id: string) {
  const row = db().select().from(n).where(eq(n.userId, id)).orderBy(desc(n.id)).get()
  return row ? String(row.id) : null
}
function notificationChanged(id: string) {
  liveHub.publishToUser(id, { type: 'notification.read', topic: `user:${id}`, data: { unreadCount: unreadCount(id) } })
}
export function readNotifications(id: string, ids?: string[], now = Date.now()) {
  if (ids?.length === 0) return
  db()
    .update(n)
    .set({ readAt: now })
    .where(and(eq(n.userId, id), isNull(n.readAt), ids ? inArray(n.id, ids.map(Number)) : undefined))
    .run()
  notificationChanged(id)
}
export function dismissNotification(userId: string, id: string, now = Date.now()) {
  db()
    .update(n)
    .set({ dismissedAt: now })
    .where(and(eq(n.userId, userId), eq(n.id, Number(id))))
    .run()
  notificationChanged(userId)
}
function dismissRequest(actor: string, target: string, now: number) {
  db()
    .update(n)
    .set({ dismissedAt: now })
    .where(and(eq(n.userId, target), eq(n.actorId, actor), eq(n.type, 'friend.request'), isNull(n.dismissedAt)))
    .run()
  notificationChanged(target)
}
function changed(a: string, b: string) {
  for (const id of [a, b]) liveHub.publishToUser(id, { type: 'friends.changed', topic: `user:${id}`, data: {} })
}
const attempts = new Map<string, number[]>()
export function requestFriend(id: string, handle: string, now = Date.now()) {
  const recent = (attempts.get(id) ?? []).filter((time) => now - time < 3600000)
  if (recent.length >= 20) throw new HttpError(429, 'RATE_LIMITED', t('好友请求过于频繁，请稍后重试'))
  recent.push(now)
  attempts.set(id, recent)
  if (db().select().from(users).where(eq(users.id, id)).get()?.kind !== 'normal') throw denied()
  const target = findUserByHandle(handle, id)
  if (!target || target.id === id || blocked(id, target.id)) throw denied()
  const row = db().select().from(f).where(wherePair(id, target.id)).get()
  if (row?.status === 'accepted') return
  if (row && row.respondedAt === null) {
    if (row.requestedBy !== id) respondFriend(id, target.id, 'accept', now)
    return
  }
  if (row?.requestedBy === id && row.respondedAt != null && now - row.respondedAt < 86400000) {
    const retryAfter = Math.ceil((row.respondedAt + 86400000 - now) / 1000)
    throw new HttpError(429, 'SOCIAL_COOLDOWN', t('对方已拒绝，请在 {seconds} 秒后重试', { seconds: retryAfter }), {
      retryAfter,
    })
  }
  db()
    .insert(f)
    .values({ ...pair(id, target.id), requestedBy: id, status: 'pending', createdAt: now })
    .onConflictDoUpdate({
      target: [f.userA, f.userB],
      set: { requestedBy: id, status: 'pending', createdAt: now, respondedAt: null },
    })
    .run()
  notify(target.id, 'friend.request', id, {}, now)
  changed(id, target.id)
}
export function respondFriend(id: string, other: string, action: 'accept' | 'reject' | 'cancel', now = Date.now()) {
  if (db().select().from(users).where(eq(users.id, id)).get()?.kind === 'external') throw denied()
  const row = db().select().from(f).where(wherePair(id, other)).get()
  if (
    row?.status !== 'pending' ||
    row.respondedAt !== null ||
    (action === 'cancel') !== (row.requestedBy === id) ||
    blocked(id, other) ||
    !db()
      .select()
      .from(users)
      .where(and(eq(users.id, other), eq(users.disabled, false), eq(users.kind, 'normal')))
      .get()
  )
    throw denied()
  if (action === 'cancel') db().delete(f).where(wherePair(id, other)).run()
  else
    db()
      .update(f)
      .set({ status: action === 'accept' ? 'accepted' : 'pending', respondedAt: now })
      .where(wherePair(id, other))
      .run()
  dismissRequest(row.requestedBy, row.requestedBy === id ? other : id, now)
  if (action === 'accept') notify(row.requestedBy, 'friend.accepted', id, {}, now)
  changed(id, other)
}
export function removeFriend(id: string, other: string) {
  db()
    .delete(f)
    .where(and(wherePair(id, other), eq(f.status, 'accepted')))
    .run()
  changed(id, other)
}
export function listFriends(id: string): FriendsDTO {
  const result: FriendsDTO = { friends: [], incoming: [], outgoing: [] }
  for (const row of db()
    .select()
    .from(f)
    .where(or(eq(f.userA, id), eq(f.userB, id)))
    .all()) {
    const otherId = row.userA === id ? row.userB : row.userA
    const other = db()
      .select()
      .from(users)
      .where(and(eq(users.id, otherId), eq(users.disabled, false), eq(users.kind, 'normal')))
      .get()
    if (!other || blocked(id, otherId)) continue
    if (row.status === 'accepted')
      result.friends.push({ ...publicUser(other), presence: presence.getPresence(id, [otherId])[otherId]! })
    else if (row.respondedAt === null)
      result[row.requestedBy === id ? 'outgoing' : 'incoming'].push({
        user: publicUser(other),
        createdAt: row.createdAt,
      })
  }
  return result
}
export function blockUser(id: string, other: string, now = Date.now()) {
  if (id === other || !db().select().from(users).where(eq(users.id, other)).get()) throw denied()
  db().transaction(() => {
    db().insert(b).values({ blockerId: id, blockedId: other, createdAt: now }).onConflictDoNothing().run()
    db().delete(f).where(wherePair(id, other)).run()
  })
  dismissRequest(id, other, now)
  dismissRequest(other, id, now)
  changed(id, other)
}
export function unblockUser(id: string, other: string) {
  db()
    .delete(b)
    .where(and(eq(b.blockerId, id), eq(b.blockedId, other)))
    .run()
}
export function listBlocks(id: string) {
  return db()
    .select({ id: users.id, handle: users.handle, name: users.name })
    .from(b)
    .innerJoin(users, eq(users.id, b.blockedId))
    .where(eq(b.blockerId, id))
    .all()
}
