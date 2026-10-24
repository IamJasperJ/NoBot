import type { ChannelActorDTO, ChannelBindingDTO, CurrentUserDTO } from '@nobot/shared'
import { and, eq } from 'drizzle-orm'
import { systemDatabase } from '../../../db/system-client'
import { roomBans, roomMembers, users } from '../../../db/system-schema'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { ensureExternalUser } from '../../../services/external-users'
import { directoryChange, members, membership, refused, requireRole } from '../../../services/rooms'
import { blocked } from '../../../services/social'
import { currentUser, runAsRoomActor } from '../../../user-context'

/** 平台不支持旁观；授权只允许正常玩家，仍沿用房间容量、封禁、规则和双向拉黑。 */
export function addChannelMember(roomId: string, actor: ChannelActorDTO, acceptedRulesVersion?: number) {
  const { room } = requireRole(roomId, ['owner', 'gm'])
  const db = systemDatabase()
  const id =
    actor.linkedUserId ?? ensureExternalUser(actor.provider, currentUser().id, actor.externalId, actor.displayName).id
  const user = db.select().from(users).where(eq(users.id, id)).get()
  if (
    !user ||
    user.disabled ||
    actor.role === 'blocked' ||
    blocked(room.hostUserId, id) ||
    db
      .select()
      .from(roomBans)
      .where(and(eq(roomBans.roomId, roomId), eq(roomBans.userId, id)))
      .get()
  )
    throw refused()
  const existing = db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, id)))
    .get()
  if (existing?.state === 'active') {
    if (existing.role === 'spectator') throw refused()
    if (existing.acceptedRulesVersion !== room.rulesVersion && acceptedRulesVersion !== room.rulesVersion)
      throw new HttpError(409, 'RULES_CHANGED', t('请先同意最新房间规则'))
    return id
  }
  if ((room.contentRating !== 'general' || room.rules) && acceptedRulesVersion !== room.rulesVersion)
    throw new HttpError(409, 'RULES_CHANGED', t('请先同意最新房间规则'))
  if (members(roomId).filter((m) => m.role !== 'spectator').length >= room.maxMembers)
    throw new HttpError(409, 'ROOM_FULL', t('房间人数已满'))
  directoryChange(room, currentUser().id, 'room.member', { action: 'joined', userId: id }, () => {
    db.insert(roomMembers)
      .values({
        roomId,
        userId: id,
        role: 'player',
        personaName: actor.displayName,
        personaDescription: '',
        acceptedRulesVersion: room.rulesVersion,
        joinedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [roomMembers.roomId, roomMembers.userId],
        set: {
          state: 'active',
          role: 'player',
          acceptedRulesVersion: room.rulesVersion,
          personaName: actor.displayName,
          personaDescription: '',
        },
      })
      .run()
  })
  return id
}
export function asChannelActor<T>(binding: ChannelBindingDTO, actor: ChannelActorDTO, fn: () => T): T {
  const id = actor.linkedUserId ?? actor.externalUserId
  if (!id || actor.role === 'blocked') throw refused()
  const user = systemDatabase()
    .select()
    .from(users)
    .where(and(eq(users.id, id), eq(users.disabled, false)))
    .get()
  if (!user) throw refused()
  if (binding.roomId) membership(binding.roomId, id)
  else if (actor.role !== 'owner' || id !== currentUser().id) throw refused()
  const identity: CurrentUserDTO = { id: user.id, handle: user.handle, name: user.name, isAdmin: false }
  return runAsRoomActor(identity, fn)
}
