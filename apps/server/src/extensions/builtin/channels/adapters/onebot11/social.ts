import { and, eq, lte } from 'drizzle-orm'
import { db, newId } from '../../../../../db/client'
import { channelAccounts, channelActors, channelRequests } from '../../../../../db/schema'
import { HttpError } from '../../../../../errors'
import { t } from '../../../../../i18n'
import { liveHub } from '../../../../../services/live/hub'
import { notify } from '../../../../../services/social'
import { currentUser } from '../../../../../user-context'
import { groupAdded, markLeft } from '../../policies'
import { accountRow, markReceived } from '../../store'
import type { OneBotClient } from './client'

export function expireOneBotRequests(now = Date.now()) {
  db.update(channelRequests)
    .set({ state: 'expired' })
    .where(and(eq(channelRequests.state, 'pending'), lte(channelRequests.expiresAt, now)))
    .run()
}
export async function decideOneBotRequest(id: string, approve: boolean, client: OneBotClient) {
  expireOneBotRequests()
  const request = db.select().from(channelRequests).where(eq(channelRequests.id, id)).get()
  if (request?.state !== 'pending' || !request.flag)
    throw new HttpError(409, 'REQUEST_EXPIRED', t('渠道请求已过期或已处理'))
  const policy = accountRow(request.accountId).config.policies
  if (approve && request.kind === 'friend' && (await client.friendList(true)).length >= policy.limits.maxFriends)
    throw new HttpError(409, 'FRIEND_LIMIT', t('渠道好友数量已达上限'))
  if (approve && request.kind === 'group-invite') {
    const groups = await client.action<{ group_id: number }[]>('get_group_list')
    if (!groups.some((group) => `-${group.group_id}` === request.chat) && groups.length >= policy.limits.maxGroups)
      throw new HttpError(409, 'GROUP_LIMIT', t('渠道群数量已达上限'))
  }
  if (request.kind === 'friend') {
    await client.action('set_friend_add_request', { flag: request.flag, approve })
    client.invalidateFriends()
  } else
    await client.action('set_group_add_request', { flag: request.flag, sub_type: request.subType, approve, reason: '' })
  db.update(channelRequests)
    .set({ state: approve ? 'approved' : 'rejected' })
    .where(eq(channelRequests.id, id))
    .run()
  liveHub.publishToUser(currentUser().id, { type: 'channel.request', topic: `user:${currentUser().id}`, data: { id } })
}
export async function receiveOneBotSocial(id: string, input: unknown, client: OneBotClient) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const event = input as Record<string, unknown>
  if (event.post_type === 'message' || event.post_type === 'message_sent') return false
  if (event.post_type !== 'request' && event.post_type !== 'notice') return true
  const key =
    event.post_type === 'request'
      ? `request:${event.request_type}:${event.sub_type ?? ''}:${event.flag}`
      : `notice:${event.notice_type}:${event.sub_type ?? ''}:${event.group_id ?? ''}:${event.user_id}:${event.time}`
  if (!markReceived(id, key, Date.now())) return true
  const row = accountRow(id)
  if (event.post_type === 'request') {
    const kind =
      event.request_type === 'friend'
        ? 'friend'
        : event.request_type === 'group'
          ? event.sub_type === 'invite'
            ? 'group-invite'
            : event.sub_type === 'add'
              ? 'join-request'
              : null
          : null
    if (!kind || typeof event.flag !== 'string' || !event.flag) return true
    if (kind === 'join-request' && row.config.policies.joinRequests !== 'notify') return true
    expireOneBotRequests()
    const actor = db
      .select()
      .from(channelActors)
      .where(and(eq(channelActors.provider, 'onebot11'), eq(channelActors.externalId, String(event.user_id))))
      .get()
    const request = db
      .insert(channelRequests)
      .values({
        id: newId(),
        accountId: id,
        kind,
        chat: kind === 'friend' ? String(event.user_id) : `-${event.group_id}`,
        title: String(event.comment ?? event.group_id ?? event.user_id),
        actorExternalId: String(event.user_id),
        actorName: actor?.displayName ?? String(event.user_id),
        flag: event.flag,
        subType: typeof event.sub_type === 'string' ? event.sub_type : null,
        // QQ 未公开 flag 固定寿命；本地保守地只允许十分钟内审批，远端仍可能提前失效。
        expiresAt: Date.now() + 600000,
        state: 'pending',
        createdAt: Date.now(),
      })
      .returning()
      .get()
    const policy = row.config.policies
    const known = !!actor && actor.role !== 'blocked' && actor.accountIds.includes(id)
    const auto =
      kind === 'friend'
        ? policy.friendRequest === 'all' || (policy.friendRequest === 'paired' && known)
        : kind === 'group-invite'
          ? policy.groupInvite === 'all' || (policy.groupInvite === 'trusted' && known)
          : false
    if (
      (kind === 'friend' && policy.friendRequest === 'never') ||
      (kind === 'group-invite' && policy.groupInvite === 'never')
    )
      await decideOneBotRequest(request.id, false, client)
    else if (auto) await decideOneBotRequest(request.id, true, client).catch(() => {})
    if (db.select().from(channelRequests).where(eq(channelRequests.id, request.id)).get()?.state === 'pending') {
      notify(currentUser().id, 'channel.location.pending', null, { requestId: request.id, title: request.title })
      liveHub.publishToUser(currentUser().id, {
        type: 'channel.request',
        topic: `user:${currentUser().id}`,
        data: { ...request, flag: undefined },
      })
    }
    return true
  }
  if (event.notice_type === 'friend_add') client.invalidateFriends()
  if (String(event.user_id) === client.selfId) {
    const chat = `-${event.group_id}`
    if (event.notice_type === 'group_decrease') markLeft(id, chat)
    if (event.notice_type === 'group_increase')
      await groupAdded(id, chat, String(event.group_id), String(event.operator_id ?? event.user_id), client)
    if (event.notice_type === 'group_admin') {
      const permissions = await client.action<{ role: string }>('get_group_member_info', {
        group_id: event.group_id,
        user_id: Number(client.selfId),
        no_cache: true,
      })
      const fresh = accountRow(id)
      db.update(channelAccounts)
        .set({
          botSnapshot: {
            ...fresh.botSnapshot,
            groupPermissions: {
              ...(fresh.botSnapshot.groupPermissions as Record<string, unknown> | undefined),
              [chat]: permissions.role,
            },
          },
        })
        .where(eq(channelAccounts.id, id))
        .run()
    }
  }
  return true
}
