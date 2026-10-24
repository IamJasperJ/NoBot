import { randomBytes } from 'node:crypto'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type createRoomInput,
  type RoomDTO,
  type RoomPersonaInput,
  type RoomRole,
  type roomInviteInput,
  type roomJoinInput,
  roomPermissions,
  type updateRoomInput,
} from '@nobot/shared'
import { and, eq, gt, lt, or, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { db, newId, setSetting } from '../../db/client'
import { characters, groupMembers, messages, personas, roomEvents, roomMessageIndex, roomUsage } from '../../db/schema'
import { systemDatabase as system } from '../../db/system-client'
import { roomBans, roomInvites, roomMembers, rooms, users } from '../../db/system-schema'
import { HttpError } from '../../errors'
import { t } from '../../i18n'
import { thumbFile } from '../../lib/files'
import { currentPaths, currentUser, runAsUser } from '../../user-context'
import { hashToken } from '../auth'
import { getChatRow } from '../chats'
import { abortGeneration } from '../generation/generation'
import { liveHub } from '../live/hub'
import { blocked, friendIds, notify } from '../social'
import { canReadMessage, roomCover, roomPayload } from './dto'
import { nextSession, resumeExtensions, unreadDetails } from './extensions'
import { lobbyAssetUrl } from './lobby'
import { initiativeSnapshot, restoreChoices, resumeRoom, roundSnapshot } from './trpg'
import { rescheduleRoom } from './turns'

export type Room = typeof rooms.$inferSelect
export const unavailable = () => new HttpError(404, 'NOT_FOUND', t('房间不存在或无法访问'))
export const refused = () => new HttpError(403, 'ROOM_REFUSED', t('没有权限执行此房间操作'))
export function roomRow(id: string): Room {
  const room = system().select().from(rooms).where(eq(rooms.id, id)).get()
  if (!room) throw unavailable()
  return room
}
export function membership(id: string, userId = currentUser().id) {
  const room = roomRow(id)
  const member = system()
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, id), eq(roomMembers.userId, userId), eq(roomMembers.state, 'active')))
    .get()
  if (!member) throw unavailable()
  return { room, member }
}
export function requireRole(id: string, roles: RoomRole[]) {
  const scope = membership(id)
  if (!roles.includes(scope.member.role)) throw refused()
  return scope
}
export function asHost<T>(room: Room, fn: () => T): T {
  const host = system()
    .select()
    .from(users)
    .where(and(eq(users.id, room.hostUserId), eq(users.disabled, false)))
    .get()
  if (!host) throw unavailable()
  return runAsUser(host, fn)
}
export function members(roomId: string) {
  return system()
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.state, 'active')))
    .orderBy(roomMembers.joinedAt, roomMembers.userId)
    .all()
}
export function charactersForRoom(room: Room, includeMuted = true) {
  const chat = getChatRow(room.chatId)
  const ids = chat.characterId
    ? [chat.characterId]
    : db
        .select()
        .from(groupMembers)
        .where(eq(groupMembers.groupId, chat.groupId!))
        .all()
        .filter((m) => includeMuted || !m.muted)
        .map((m) => m.characterId)
  return ids.flatMap((id) => {
    const c = db.select().from(characters).where(eq(characters.id, id)).get()
    return c ? [c] : []
  })
}
export function event(room: Room, type: string, actorId: string, payload: Record<string, unknown>, entityId?: string) {
  const seq =
    db
      .select({ n: sql<number>`coalesce(max(${roomEvents.seq}), 0)` })
      .from(roomEvents)
      .where(eq(roomEvents.roomId, room.id))
      .get()!.n + 1
  const data = {
    roomId: room.id,
    seq,
    type,
    actorId,
    entityId: entityId ?? null,
    payload: roomPayload(payload),
    createdAt: Date.now(),
  }
  db.insert(roomEvents).values(data).run()
  if (entityId && (type === 'room.message' || type === 'room.generation') && payload.message) {
    db.insert(roomMessageIndex).values({ roomId: room.id, messageId: entityId, seq }).onConflictDoNothing().run()
  }
  db.delete(roomEvents)
    .where(and(eq(roomEvents.roomId, room.id), lt(roomEvents.seq, seq - 1999)))
    .run()
  return data
}
export function projectRoomEvent(data: ReturnType<typeof event>, viewerId: string, room = roomRow(data.roomId)) {
  return asHost(room, () => {
    if (data.type === 'room.asset' && data.entityId) {
      const message = db.select().from(messages).where(eq(messages.id, data.entityId)).get()
      if (message && !canReadMessage(message, viewerId, room.hostUserId)) return { ...data, payload: {} }
    }
    if (data.type.startsWith('room.character.') && !['room.character.withdrawn'].includes(data.type))
      return { ...data, payload: {} }
    const viewer = membership(room.id, viewerId).member
    if (viewer.role === 'spectator') {
      const message = data.payload.message ?? data.payload.assistantMessage
      if (
        ['room.round', 'room.initiative', 'room.turn', 'room.typing', 'room.suggestion'].includes(data.type) ||
        data.seq <= (room.spectatorHistory === 'since-join' ? viewer.joinedSeq : -1) ||
        (message &&
          typeof message === 'object' &&
          'meta' in message &&
          !canReadMessage(message as typeof messages.$inferSelect, viewerId))
      )
        return { ...data, type: 'room.cursor', entityId: null, payload: {} }
    }
    return { ...data, payload: roomPayload(data.payload, viewerId, room.hostUserId) }
  })
}
const channelListeners = new Set<(data: ReturnType<typeof event>) => void>()
/** 渠道订阅收到原事件后必须逐成员调用 projectRoomEvent；不能直接公开 payload。 */
export function subscribeRoomEvents(listener: (data: ReturnType<typeof event>) => void) {
  channelListeners.add(listener)
  return () => channelListeners.delete(listener)
}
export function publish(data: ReturnType<typeof event>) {
  for (const listener of channelListeners) {
    try {
      listener(data)
    } catch {
      /* 渠道故障不能阻断网页房间广播。 */
    }
  }
  const room = roomRow(data.roomId)
  const topic = `room:${data.roomId}`
  for (const member of members(data.roomId))
    liveHub.publishToTopic(
      topic,
      {
        type: projectRoomEvent(data, member.userId, room).type,
        topic,
        data: projectRoomEvent(data, member.userId, room),
      },
      (userId) => userId === member.userId,
    )
}
export function changed(room: Room, type: string, actor: string, payload: Record<string, unknown>) {
  asHost(room, () => publish(db.transaction(() => event(room, type, actor, payload))))
}
/** 系统目录和房主事件通过同一个 SQLite 连接提交，避免 ACL 已变而事件未写入。 */
export function directoryChange<T>(
  room: Room,
  actorId: string,
  type: string,
  payload: Record<string, unknown>,
  change: () => T,
): T {
  const file = asHost(room, () => currentPaths().db)
  const sqlite = system().$client
  sqlite.query('ATTACH DATABASE ? AS room_story').run(file)
  let data: ReturnType<typeof event> | undefined
  try {
    const result = system().transaction(
      () => {
        const result = change()
        const seq = sqlite
          .query<{ n: number }, [string]>(
            'SELECT coalesce(max(seq), 0) + 1 AS n FROM room_story.room_events WHERE room_id = ?',
          )
          .get(room.id)!.n
        data = { roomId: room.id, seq, type, actorId, entityId: null, payload, createdAt: Date.now() }
        sqlite
          .query(
            'INSERT INTO room_story.room_events (room_id, seq, type, actor_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(room.id, seq, type, actorId, JSON.stringify(payload), data.createdAt)
        sqlite.query('DELETE FROM room_story.room_events WHERE room_id = ? AND seq < ?').run(room.id, seq - 1999)
        return result
      },
      { behavior: 'immediate' },
    )
    if (data) publish(data)
    return result
  } finally {
    sqlite.exec('DETACH DATABASE room_story')
  }
}
export function roomDetail(id: string): RoomDTO {
  const { room, member } = membership(id)
  asHost(room, () => restoreChoices(room))
  return {
    ...room,
    coverAsset: room.coverAsset?.startsWith('/api/assets/')
      ? `/api/rooms/${room.id}/scope${roomCover(room.coverAsset)!.slice(4)}`
      : room.coverAsset,
    nextSession: nextSession(id, member.userId),
    spectators: members(id).filter((m) => m.role === 'spectator'),
    members: members(id)
      .filter((m) => m.role !== 'spectator')
      .map((m) => ({ ...m, inRoom: liveHub.topicUsers(`room:${id}`).includes(m.userId) })),
    myUserId: member.userId,
    myRole: member.role,
    permissions: {
      ...roomPermissions(
        member.role,
        room.status === 'active',
        member.acceptedRulesVersion === room.rulesVersion,
        room.allowMemberInvites,
        room.allowGmKick,
      ),
      canApproveCharacters: member.role === 'owner' || (member.role === 'gm' && room.gmApprovesCharacters),
      canSendIc:
        member.role !== 'spectator' &&
        room.status === 'active' &&
        member.acceptedRulesVersion === room.rulesVersion &&
        (room.turnMode !== 'initiative' ||
          asHost(room, () => {
            const initiative = initiativeSnapshot(room)
            const entry = initiative.order[initiative.current]
            return entry?.kind === 'member' && entry.id === member.userId
          })),
      canPickChoice:
        member.role !== 'spectator' &&
        room.status === 'active' &&
        member.acceptedRulesVersion === room.rulesVersion &&
        (room.choiceMode !== 'gm' || member.role !== 'player'),
    },
    unreadCount: unreadDetails(id).count,
    round: asHost(room, () => roundSnapshot(room)),
    initiative: asHost(room, () => initiativeSnapshot(room)),
  }
}
export function listRooms() {
  return system()
    .select({ id: rooms.id })
    .from(rooms)
    .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
    .where(and(eq(roomMembers.userId, currentUser().id), eq(roomMembers.state, 'active')))
    .all()
    .flatMap(({ id }) => {
      try {
        return [roomDetail(id)]
      } catch {
        return []
      }
    })
}
function personaSnapshot(personaId?: string) {
  const p = personaId ? db.select().from(personas).where(eq(personas.id, personaId)).get() : undefined
  if (personaId && !p) throw unavailable()
  return {
    personaName: p?.name ?? currentUser().name,
    personaDescription: p?.description ?? '',
    personaAvatarFile: p?.avatarFile ?? null,
  }
}
function copyPersona(room: Room, personaId: string) {
  const p = personaSnapshot(personaId)
  const userId = currentUser().id
  const sheet = db.select().from(personas).where(eq(personas.id, personaId)).get()?.sheet ?? null
  asHost(room, () => setSetting(`room-sheet:${room.id}:${userId}`, sheet))
  if (p.personaAvatarFile) {
    const source = join(currentPaths().avatars, p.personaAvatarFile)
    const file = `${newId()}.${p.personaAvatarFile.split('.').pop()}`
    asHost(room, () => copyFileSync(source, join(currentPaths().avatars, file)))
    const thumbnail = join(currentPaths().avatars, thumbFile(p.personaAvatarFile))
    asHost(room, () => copyFileSync(thumbnail, join(currentPaths().avatars, thumbFile(file))))
    p.personaAvatarFile = file
  }
  return p
}
export function createRoom(input: z.infer<typeof createRoomInput>) {
  getChatRow(input.chatId)
  if (system().select().from(rooms).where(eq(rooms.chatId, input.chatId)).get()) throw refused()
  const { personaId, ...settings } = input
  const now = Date.now(),
    id = newId(),
    userId = currentUser().id
  system().transaction(() => {
    system()
      .insert(rooms)
      .values({
        ...settings,
        turnMode: settings.turnMode ?? (settings.mode === 'trpg' ? 'host' : 'smart'),
        id,
        hostUserId: userId,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    system()
      .insert(roomMembers)
      .values({
        roomId: id,
        userId,
        role: 'owner',
        ...personaSnapshot(personaId),
        acceptedRulesVersion: 1,
        joinedAt: now,
      })
      .run()
  })
  const room = roomRow(id)
  setSetting(
    `room-sheet:${id}:${userId}`,
    personaId ? (db.select().from(personas).where(eq(personas.id, personaId)).get()?.sheet ?? null) : null,
  )
  const initial = db.transaction(() => {
    const owner = membership(id).member
    for (const message of db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, input.chatId), eq(messages.role, 'user')))
      .all()) {
      const name = message.meta.name ?? owner.personaName
      db.update(messages)
        .set({ meta: { ...message.meta, author: { userId, name }, name, channel: message.meta.channel ?? 'ic' } })
        .where(eq(messages.id, message.id))
        .run()
    }
    for (const m of db.select().from(messages).where(eq(messages.chatId, input.chatId)).all())
      db.insert(roomMessageIndex).values({ roomId: id, messageId: m.id, seq: 0 }).run()
    return event(room, 'room.settings', userId, { settings: room })
  })
  publish(initial)
  asHost(room, () => resumeRoom(room))
  return roomDetail(id)
}
export function updateRoom(id: string, input: z.infer<typeof updateRoomInput>) {
  const { room } = requireRole(id, ['owner'])
  const bump = (['contentRating', 'contentNotes', 'rules', 'allowSpectators'] as const).some(
    (k) => input[k] !== undefined && input[k] !== room[k],
  )
  directoryChange(
    room,
    currentUser().id,
    'room.settings',
    { settings: { ...room, ...input, rulesVersion: room.rulesVersion + Number(bump) } },
    () => {
      system()
        .update(rooms)
        .set({ ...input, rulesVersion: room.rulesVersion + Number(bump), updatedAt: Date.now() })
        .where(eq(rooms.id, id))
        .run()
    },
  )
  rescheduleRoom(id)
  const latestRoom = roomRow(id)
  asHost(latestRoom, () => resumeRoom(latestRoom))
  return roomDetail(id)
}
export function deleteRoom(id: string) {
  const { room } = requireRole(id, ['owner'])
  asHost(room, () => abortGeneration(room.chatId))
  for (const m of members(id)) {
    liveHub.publishToUser(m.userId, { type: 'room.removed', topic: `user:${m.userId}`, data: { roomId: id } })
    liveHub.disconnectUserFromTopic(m.userId, `room:${id}`)
  }
  asHost(room, () =>
    db.transaction(() => {
      db.delete(roomMessageIndex).where(eq(roomMessageIndex.roomId, id)).run()
      db.delete(roomEvents).where(eq(roomEvents.roomId, id)).run()
      db.delete(roomUsage).where(eq(roomUsage.roomId, id)).run()
    }),
  )
  system().delete(rooms).where(eq(rooms.id, id)).run()
}
export function createInvite(id: string, input: z.infer<typeof roomInviteInput>) {
  const { room, member } = membership(id)
  if (
    member.role === 'spectator' ||
    (input.role === 'spectator' && (!room.allowSpectators || member.role === 'player'))
  )
    throw refused()
  if (member.role === 'player' && !room.allowMemberInvites) throw refused()
  if (
    input.kind === 'direct' &&
    (!input.targetUserId ||
      !friendIds(currentUser().id).includes(input.targetUserId) ||
      blocked(currentUser().id, input.targetUserId) ||
      blocked(room.hostUserId, input.targetUserId))
  )
    throw refused()
  const token = input.kind === 'link' ? randomBytes(32).toString('base64url') : undefined
  const invite = system()
    .insert(roomInvites)
    .values({
      id: newId(),
      roomId: id,
      createdBy: currentUser().id,
      kind: input.kind,
      role: input.role,
      targetUserId: input.kind === 'direct' ? input.targetUserId : null,
      tokenHash: token ? hashToken(token) : null,
      expiresAt: Date.now() + input.expiresIn,
      maxUses: input.maxUses ?? (input.kind === 'direct' ? 1 : null),
    })
    .returning()
    .get()
  if (invite.targetUserId)
    notify(invite.targetUserId, 'room.invite', currentUser().id, {
      inviteId: invite.id,
      roomId: id,
      name: room.name,
      contentRating: room.contentRating,
      ...(room.contentRating === 'general' ? { description: room.description } : {}),
    })
  const { tokenHash: _, ...dto } = invite
  return { ...dto, ...(token ? { token, url: `/join/${token}` } : {}) }
}
export function validInvite(value: string, userId = currentUser().id) {
  const invite = system()
    .select()
    .from(roomInvites)
    .where(or(eq(roomInvites.id, value), eq(roomInvites.tokenHash, hashToken(value))))
    .get()
  if (
    !invite ||
    invite.revokedAt !== null ||
    invite.expiresAt <= Date.now() ||
    (invite.maxUses !== null && invite.uses >= invite.maxUses) ||
    (invite.kind === 'direct' && invite.targetUserId !== userId)
  )
    throw unavailable()
  if (invite.kind === 'link' && invite.tokenHash !== hashToken(value)) throw unavailable()
  const room = roomRow(invite.roomId)
  if (
    room.status === 'archived' ||
    blocked(room.hostUserId, userId) ||
    system()
      .select()
      .from(roomBans)
      .where(and(eq(roomBans.roomId, room.id), eq(roomBans.userId, userId)))
      .get()
  )
    throw unavailable()
  return { invite, room }
}
export function lobby(value: string) {
  const { room, invite } = validInvite(value)
  const host = system().select().from(users).where(eq(users.id, room.hostUserId)).get()!
  return {
    id: room.id,
    name: room.name,
    description: room.description,
    coverAsset: lobbyAssetUrl(value, room.coverAsset),
    hostName: host.name,
    inviteRole: invite.role,
    spectatorHistory: room.spectatorHistory,
    spectators: members(room.id)
      .filter((m) => m.role === 'spectator')
      .map((m) => m.personaName),
    members: members(room.id)
      .filter((m) => m.role !== 'spectator')
      .map((m) => m.personaName),
    characters: asHost(room, () =>
      charactersForRoom(room).map((c) => ({
        name: c.name,
        avatarUrl: lobbyAssetUrl(value, c.avatarFile ? `/api/assets/avatars/${thumbFile(c.avatarFile)}` : null),
        description: c.creatorNotes.slice(0, 200),
      })),
    ),
    contentRating: room.contentRating,
    contentNotes: room.contentNotes,
    rules: room.rules,
    rulesVersion: room.rulesVersion,
    payer: t('模型由 {name} 提供', { name: host.name }),
    historyNote:
      invite.role === 'spectator' && room.spectatorHistory === 'since-join'
        ? t('旁观者只能查看加入后的公共历史')
        : t('加入后可以查看全部公共历史'),
    guestQuota: room.guestQuota,
  }
}
export function joinRoom(input: z.infer<typeof roomJoinInput>) {
  const userId = currentUser().id
  const { room: initial } = validInvite(input.invite)
  const snapshot = copyPersona(initial, input.personaId)
  const id = directoryChange(initial, userId, 'room.member', { action: 'joined', userId }, () => {
    const { invite, room } = validInvite(input.invite)
    const user = system().select().from(users).where(eq(users.id, userId)).get()
    if (!user || user.disabled) throw unavailable()
    if (input.acceptedRulesVersion !== room.rulesVersion)
      throw new HttpError(409, 'RULES_CHANGED', t('请先同意最新房间规则'))
    const existing = system()
      .select()
      .from(roomMembers)
      .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, userId)))
      .get()
    if (existing?.state === 'active') return room.id
    if (invite.role === 'spectator' && !room.allowSpectators) throw refused()
    if (
      members(room.id).filter((m) => (m.role === 'spectator') === (invite.role === 'spectator')).length >=
      (invite.role === 'spectator' ? room.maxSpectators : room.maxMembers)
    )
      throw new HttpError(409, 'ROOM_FULL', t('房间人数已满'))
    system()
      .update(roomInvites)
      .set({ uses: invite.uses + 1 })
      .where(eq(roomInvites.id, invite.id))
      .run()
    system()
      .insert(roomMembers)
      .values({
        roomId: room.id,
        userId,
        role: invite.role,
        ...snapshot,
        acceptedRulesVersion: room.rulesVersion,
        joinedAt: Date.now(),
        joinedSeq: asHost(
          room,
          () =>
            db
              .select({ n: sql<number>`coalesce(max(${roomEvents.seq}), 0)` })
              .from(roomEvents)
              .where(eq(roomEvents.roomId, room.id))
              .get()!.n,
        ),
      })
      .onConflictDoUpdate({
        target: [roomMembers.roomId, roomMembers.userId],
        set: {
          ...snapshot,
          state: 'active',
          role: invite.role,
          acceptedRulesVersion: room.rulesVersion,
          joinedAt: Date.now(),
          joinedSeq: asHost(
            room,
            () =>
              db
                .select({ n: sql<number>`coalesce(max(${roomEvents.seq}), 0)` })
                .from(roomEvents)
                .where(eq(roomEvents.roomId, room.id))
                .get()!.n,
          ),
        },
      })
      .run()
    return room.id
  })
  asHost(roomRow(id), () => resumeRoom(roomRow(id)))
  return roomDetail(id)
}
export function removeMember(id: string, userId: string, action: 'left' | 'kicked' | 'banned') {
  const { room, member } = membership(id)
  const target = membership(id, userId).member
  if (
    target.role === 'owner' ||
    (action === 'left'
      ? userId !== currentUser().id
      : action === 'banned'
        ? member.role !== 'owner'
        : !(member.role === 'owner' || (member.role === 'gm' && room.allowGmKick && target.role === 'player')))
  )
    throw refused()
  directoryChange(room, currentUser().id, 'room.member', { action, userId }, () => {
    if (action === 'banned')
      system()
        .insert(roomBans)
        .values({ roomId: id, userId, by: currentUser().id, createdAt: Date.now() })
        .onConflictDoNothing()
        .run()
    system()
      .update(roomMembers)
      .set({ state: action === 'left' ? 'left' : 'kicked' })
      .where(and(eq(roomMembers.roomId, id), eq(roomMembers.userId, userId)))
      .run()
  })
  liveHub.publishToUser(userId, { type: 'room.removed', topic: `user:${userId}`, data: { roomId: id } })
  liveHub.disconnectUserFromTopic(userId, `room:${id}`)
}
export function updatePersona(id: string, input: string | RoomPersonaInput) {
  const { room, member } = membership(id)
  const changes = typeof input === 'string' ? { personaId: input } : input
  const snapshot = changes.personaId
    ? copyPersona(room, changes.personaId)
    : {
        personaName: member.personaName,
        personaDescription: member.personaDescription,
        personaAvatarFile: member.personaAvatarFile,
      }
  if (changes.name !== undefined) snapshot.personaName = changes.name
  if (changes.description !== undefined) snapshot.personaDescription = changes.description
  directoryChange(
    room,
    currentUser().id,
    'room.member',
    { action: 'persona', userId: currentUser().id, ...snapshot },
    () => {
      system()
        .update(roomMembers)
        .set(snapshot)
        .where(and(eq(roomMembers.roomId, id), eq(roomMembers.userId, currentUser().id)))
        .run()
    },
  )
  return roomDetail(id)
}
export function acceptRules(id: string, version: number) {
  const { room } = membership(id)
  if (version !== room.rulesVersion) throw new HttpError(409, 'RULES_CHANGED', t('请先同意最新房间规则'))
  system()
    .update(roomMembers)
    .set({ acceptedRulesVersion: version })
    .where(and(eq(roomMembers.roomId, id), eq(roomMembers.userId, currentUser().id)))
    .run()
  return roomDetail(id)
}
export function usage(id: string) {
  const { room } = requireRole(id, ['owner'])
  return asHost(room, () => db.select().from(roomUsage).where(eq(roomUsage.roomId, id)).all())
}
export function checkWritable(room: Room, userId: string) {
  const { member } = membership(room.id, userId)
  if (member.role === 'spectator') throw refused()
  if (room.status !== 'active') throw new HttpError(409, 'ROOM_PAUSED', t('房间已暂停或归档'))
  if (member.acceptedRulesVersion !== room.rulesVersion)
    throw new HttpError(409, 'RULES_CHANGED', t('请先同意最新房间规则'))
  return member
}
const usageReservations = new Map<string, Set<{ userId: string }>>()
/** 转让时连同图片、语音等后台任务一起检查，避免快照之后仍有旧宿主任务提交。 */
export function hasRoomReservations(id: string) {
  return (usageReservations.get(id)?.size ?? 0) > 0
}
export function checkQuota(room: Room, userId: string, reserve = 1) {
  // 房主不受访客额度及每日房间额度限制，仍记入用量账本。
  if (room.hostUserId === userId) return
  const now = Date.now()
  const dayStart = new Date(now).setUTCHours(0, 0, 0, 0)
  const rows = db
    .select()
    .from(roomUsage)
    .where(and(eq(roomUsage.roomId, room.id), gt(roomUsage.createdAt, Math.min(dayStart, now - 3600000) - 1)))
    .all()
  const pending = [...(usageReservations.get(room.id) ?? [])]
  if (
    rows.filter((r) => r.createdAt >= dayStart).length + pending.length + reserve > room.guestQuota.perDay ||
    rows.filter((r) => r.userId === userId && r.createdAt > now - 3600000).length +
      pending.filter((r) => r.userId === userId).length +
      reserve >
      room.guestQuota.perHour
  )
    throw new HttpError(429, 'ROOM_QUOTA', t('房间生成额度已用尽，请稍后重试'))
}

/** 先预占再调用模型，避免文本和语音并发通过同一个剩余额度。 */
export function reserveUsage(room: Room, userId: string) {
  checkQuota(room, userId)
  let set = usageReservations.get(room.id)
  if (!set) {
    set = new Set()
    usageReservations.set(room.id, set)
  }
  const entry = { userId }
  set.add(entry)
  return () => {
    set.delete(entry)
    if (!set.size) usageReservations.delete(room.id)
  }
}

/** 正在房间的状态只向同房间的好友公开，不能仅凭好友关系暴露私密房间。 */
export function visibleRoomFor(viewer: string, userId: string) {
  const shared = system()
    .select({ room: rooms })
    .from(rooms)
    .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
    .where(and(eq(roomMembers.userId, userId), eq(roomMembers.state, 'active')))
    .all()
  for (const { room } of shared) {
    if (!liveHub.topicUsers(`room:${room.id}`).includes(userId)) continue
    if (
      system()
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, viewer), eq(roomMembers.state, 'active')))
        .get()
    )
      return { id: room.id, name: room.name }
  }
  return undefined
}

/** 房间服务的启动入口，目录可用后再恢复房主库中的状态机。 */
export function resumeRoomStates() {
  for (const room of system().select().from(rooms).all()) {
    try {
      if (room.status === 'active') asHost(room, () => resumeRoom(room))
      resumeExtensions(room)
    } catch {
      /* 已禁用的房主或损坏房间不能阻塞服务器启动。 */
    }
  }
}
