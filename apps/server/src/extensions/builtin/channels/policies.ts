import type { ChannelRequestDTO } from '@nobot/shared'
import { and, eq } from 'drizzle-orm'
import { db, newId } from '../../../db/client'
import { channelActors, channelBindings, channelRequests } from '../../../db/schema'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { liveHub } from '../../../services/live/hub'
import { notify } from '../../../services/social'
import { currentUser } from '../../../user-context'
import type { TelegramClient } from './adapters/telegram/client'
import { accountRow, listBindings, recordActorSeen } from './store'

export function requestLocation(
  accountId: string,
  kind: ChannelRequestDTO['kind'],
  chat: string,
  title: string,
  actorExternalId: string | null,
  now = Date.now(),
  actorName: string | null = null,
) {
  const previous = db
    .select()
    .from(channelRequests)
    .where(
      and(eq(channelRequests.accountId, accountId), eq(channelRequests.chat, chat), eq(channelRequests.kind, kind)),
    )
    .all()
    .find((r) => r.state === 'pending' || r.state === 'blocked')
  if (previous) {
    const request = db
      .update(channelRequests)
      .set({ title, ...(actorName ? { actorName } : {}) })
      .where(eq(channelRequests.id, previous.id))
      .returning()
      .get()
    return { request, created: false }
  }
  const request = db
    .insert(channelRequests)
    .values({ id: newId(), accountId, kind, chat, title, actorExternalId, actorName, state: 'pending', createdAt: now })
    .returning()
    .get()
  notify(currentUser().id, kind === 'group-invite' ? 'channel.group.invited' : 'channel.location.pending', null, {
    requestId: request.id,
    title,
    actorExternalId,
  })
  liveHub.publishToUser(currentUser().id, { type: 'channel.request', topic: `user:${currentUser().id}`, data: request })
  return { request, created: true }
}
export async function leaveGroup(accountId: string, chat: string, client: TelegramClient) {
  await client.call('leaveChat', { chat_id: chat })
  markLeft(accountId, chat)
}
export function markLeft(accountId: string, chat: string) {
  db.update(channelRequests)
    .set({ state: 'rejected' })
    .where(
      and(
        eq(channelRequests.accountId, accountId),
        eq(channelRequests.chat, chat),
        eq(channelRequests.state, 'approved'),
      ),
    )
    .run()
  for (const binding of listBindings(accountId).filter((b) => b.chat === chat)) {
    const { id, accountId: _, ...data } = binding
    db.update(channelBindings)
      .set({ ...data, state: 'left' })
      .where(eq(channelBindings.id, id))
      .run()
  }
}
function activateGroup(accountId: string, chat: string) {
  for (const binding of listBindings(accountId).filter(
    (b) => b.chat === chat && (b.state === 'pending' || b.state === 'left'),
  )) {
    db.update(channelBindings)
      .set({ state: 'active', lastActivityAt: Date.now(), idleWarnedAt: null })
      .where(eq(channelBindings.id, binding.id))
      .run()
  }
}
export async function groupAdded(
  accountId: string,
  chat: string,
  title: string,
  adder: string,
  client: TelegramClient,
  actorName: string | null = null,
) {
  const row = accountRow(accountId)
  const policy = row.config.policies
  const actor = db
    .select()
    .from(channelActors)
    .where(and(eq(channelActors.provider, row.config.provider), eq(channelActors.externalId, adder)))
    .get()
  const blocked = db
    .select()
    .from(channelRequests)
    .where(
      and(
        eq(channelRequests.accountId, accountId),
        eq(channelRequests.chat, chat),
        eq(channelRequests.state, 'blocked'),
      ),
    )
    .get()
  const groups = new Set(
    listBindings(accountId)
      .filter((b) => b.scope === 'group' && b.state !== 'left')
      .map((b) => b.chat),
  )
  for (const request of db
    .select()
    .from(channelRequests)
    .where(
      and(
        eq(channelRequests.accountId, accountId),
        eq(channelRequests.kind, 'group-invite'),
        eq(channelRequests.state, 'approved'),
      ),
    )
    .all())
    groups.add(request.chat)
  const approved = db
    .select()
    .from(channelRequests)
    .where(
      and(
        eq(channelRequests.accountId, accountId),
        eq(channelRequests.chat, chat),
        eq(channelRequests.state, 'approved'),
      ),
    )
    .get()
  if (blocked || policy.groupInvite === 'never' || (!groups.has(chat) && groups.size >= policy.limits.maxGroups)) {
    await leaveGroup(accountId, chat, client)
    return false
  }
  if (
    approved ||
    policy.groupInvite === 'all' ||
    (policy.groupInvite === 'trusted' && actor && actor.role !== 'blocked')
  ) {
    if (!approved)
      db.insert(channelRequests)
        .values({
          id: newId(),
          accountId,
          kind: 'group-invite',
          chat,
          title,
          actorExternalId: adder,
          actorName: actorName ?? actor?.displayName ?? null,
          state: 'approved',
          createdAt: Date.now(),
        })
        .run()
    activateGroup(accountId, chat)
    return true
  }
  const result = requestLocation(
    accountId,
    'group-invite',
    chat,
    title,
    adder,
    Date.now(),
    actorName ?? actor?.displayName ?? null,
  )
  if (result.created) await client.call('sendMessage', { chat_id: chat, text: t('正在等待主人的批准') })
  return false
}
export async function respondRequest(id: string, action: 'approve' | 'reject' | 'block', client: TelegramClient) {
  const row = db.select().from(channelRequests).where(eq(channelRequests.id, id)).get()
  if (row?.state !== 'pending') throw new HttpError(404, 'NOT_FOUND', t('渠道请求不存在'))
  if (action === 'approve' && row.kind === 'group-invite') {
    const limit = accountRow(row.accountId).config.policies.limits.maxGroups
    const groups = new Set(
      listBindings(row.accountId)
        .filter((b) => b.scope === 'group' && b.state !== 'left')
        .map((b) => b.chat),
    )
    for (const request of db
      .select()
      .from(channelRequests)
      .where(
        and(
          eq(channelRequests.accountId, row.accountId),
          eq(channelRequests.kind, 'group-invite'),
          eq(channelRequests.state, 'approved'),
        ),
      )
      .all())
      groups.add(request.chat)
    if (!groups.has(row.chat) && groups.size >= limit) throw new HttpError(409, 'GROUP_LIMIT', t('渠道群数量已达上限'))
  }
  if (
    action !== 'approve' &&
    (row.kind === 'group-invite' || (row.kind === 'new-location' && row.chat.startsWith('-')))
  )
    await leaveGroup(row.accountId, row.chat, client)
  db.update(channelRequests)
    .set({ state: action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'blocked' })
    .where(eq(channelRequests.id, id))
    .run()
  if (action === 'approve') {
    activateGroup(row.accountId, row.chat)
    if (row.kind === 'new-location' && row.actorExternalId && !row.chat.startsWith('-')) {
      const provider = accountRow(row.accountId).config.provider
      const existing = db
        .select()
        .from(channelActors)
        .where(and(eq(channelActors.provider, provider), eq(channelActors.externalId, row.actorExternalId)))
        .get()
      if (!existing) {
        const actor = db
          .insert(channelActors)
          .values({
            id: newId(),
            provider,
            externalId: row.actorExternalId,
            displayName: row.actorName ?? row.title,
            role: 'player',
            dmChatId: row.chat,
          })
          .returning()
          .get()
        recordActorSeen(row.accountId, actor, row.chat)
      }
    }
  }
  liveHub.publishToUser(currentUser().id, { type: 'channel.request', topic: `user:${currentUser().id}`, data: { id } })
}
/** 活跃时间仅代表隐私模式下 bot 能收到的消息；提醒时间持久化，重启不延长宽限期。 */
export async function checkIdle(accountId: string, client: TelegramClient, now = Date.now()) {
  const policy = accountRow(accountId).config.policies.idleLeave
  if (!policy.enabled) return
  const groups = new Map<string, ReturnType<typeof listBindings>>()
  for (const binding of listBindings(accountId)) {
    if (binding.scope !== 'group' || binding.state !== 'active' || policy.excluded.includes(binding.chat)) continue
    groups.set(binding.chat, [...(groups.get(binding.chat) ?? []), binding])
  }
  for (const [chat, bindings] of groups) {
    if (now - Math.max(...bindings.map((b) => b.lastActivityAt)) < policy.idleDays * 86400000) continue
    const warned = bindings.map((b) => b.idleWarnedAt).find((n) => n !== null)
    if (warned === undefined) {
      for (const binding of bindings) {
        const { id, accountId: _, ...data } = binding
        db.update(channelBindings)
          .set({ ...data, idleWarnedAt: now })
          .where(eq(channelBindings.id, id))
          .run()
      }
      notify(currentUser().id, 'channel.group.idle', null, { accountId, chat, graceDays: policy.graceDays })
    } else if (now - warned >= policy.graceDays * 86400000) await leaveGroup(accountId, chat, client)
  }
}
