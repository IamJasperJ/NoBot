import {
  type ChannelAccountDTO,
  type ChannelBindingDTO,
  type ChannelLogEntry,
  channelAccountInput,
} from '@nobot/shared'
import { and, eq, lt } from 'drizzle-orm'
import { db, getSetting, setSetting } from '../../../db/client'
import {
  channelAccounts,
  channelActorLocations,
  channelActors,
  channelBindings,
  channelInbox,
  channelRequests,
  chats,
} from '../../../db/schema'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { SECRET_MASK } from '../../types'
import { implementationCapabilities, providerCapabilities } from './capabilities'
import { miniAppUrl, publicBaseUrl } from './miniapp'
import { asChannelActor } from './rooms'
import { openCredentials } from './secrets'

export function accountRow(id: string) {
  const account = db.select().from(channelAccounts).where(eq(channelAccounts.id, id)).get()
  if (!account) throw new HttpError(404, 'NOT_FOUND', t('渠道账号不存在'))
  return {
    ...account,
    config: channelAccountInput.parse({ ...account, credentials: openCredentials(account.credentials) }),
  }
}
export type AccountRow = ReturnType<typeof accountRow>
export function accountDTO(row: typeof channelAccounts.$inferSelect): ChannelAccountDTO {
  const config = channelAccountInput.parse({ ...row, credentials: openCredentials(row.credentials) })
  return {
    ...config,
    riskNotice: config.provider === 'onebot11' ? t('QQ 非官方协议存在风控和封号风险，限速不能保证账号安全') : null,
    implementation:
      config.provider === 'onebot11'
        ? ((row.botSnapshot.implementation as { name: string; version: string } | undefined) ?? null)
        : null,
    canManageBots: row.botSnapshot.can_manage_bots === true,
    managedBy: row.managedBy,
    miniApp:
      config.provider === 'onebot11'
        ? { available: !!publicBaseUrl(), reason: publicBaseUrl() ? undefined : t('请先设置 HTTPS 公网地址') }
        : miniAppUrl(row.id)
          ? { available: true, url: miniAppUrl(row.id) }
          : { available: false, reason: t('请先设置 HTTPS 公网地址') },
    bindingCount: db.select().from(channelBindings).where(eq(channelBindings.accountId, row.id)).all().length,
    pendingRequestCount: db
      .select()
      .from(channelRequests)
      .where(and(eq(channelRequests.accountId, row.id), eq(channelRequests.state, 'pending')))
      .all().length,
    id: row.id,
    status: row.status,
    lastError: row.lastError,
    cursor: row.cursor,
    botId: row.botId,
    botUsername: row.botUsername,
    botSnapshot: row.botSnapshot,
    presenceSync: row.presenceSync,
    credentials: SECRET_MASK,
    capabilities:
      config.provider === 'onebot11'
        ? implementationCapabilities(
            String((row.botSnapshot.implementation as { name?: string } | undefined)?.name ?? ''),
          )
        : providerCapabilities[config.provider],
  }
}
export function bindingRow(id: string): ChannelBindingDTO {
  const row = db.select().from(channelBindings).where(eq(channelBindings.id, id)).get()
  if (!row) throw new HttpError(404, 'NOT_FOUND', t('渠道绑定不存在'))
  return bindingDTO(row)
}
export function listBindings(accountId?: string): ChannelBindingDTO[] {
  return db
    .select()
    .from(channelBindings)
    .where(accountId ? eq(channelBindings.accountId, accountId) : undefined)
    .all()
    .map(bindingDTO)
}
export function markReceived(accountId: string, externalEventId: string, now: number) {
  db.delete(channelInbox)
    .where(lt(channelInbox.receivedAt, now - 7 * 86400000))
    .run()
  return (
    db
      .insert(channelInbox)
      .values({ accountId, externalEventId, receivedAt: now })
      .onConflictDoNothing()
      .returning()
      .all().length > 0
  )
}
/** 日志只接收受控短码和本地翻译，不能传入平台异常或凭据。 */
export function channelLog(entry: ChannelLogEntry) {
  const logs = getSetting<ChannelLogEntry[]>('channels:log') ?? []
  setSetting('channels:log', [...logs, entry].slice(-200))
}

/** 位置记录只表示见过成员，展示数量仍要经过当前房间及账号授权检查。 */
function bindingDTO(row: typeof channelBindings.$inferSelect): ChannelBindingDTO {
  const { locationKey: _, topicTitle: __, ...value } = row
  const binding = {
    ...value,
    chatTitle: db.select().from(chats).where(eq(chats.id, row.chatId)).get()?.title ?? '',
    memberCount: 0,
  }
  const seen = db
    .select()
    .from(channelActorLocations)
    .where(and(eq(channelActorLocations.accountId, row.accountId), eq(channelActorLocations.chat, row.chat)))
    .all()
  const ids = new Set(
    seen.filter((s) => row.isolation !== 'per-topic' || s.thread === row.thread).map((s) => s.actorId),
  )
  for (const actor of db.select().from(channelActors).all()) {
    if (!ids.has(actor.id) || (row.isolation === 'per-user' && actor.externalId !== row.actor)) continue
    try {
      asChannelActor(binding, actor, () => {})
      binding.memberCount++
    } catch {
      // 被封禁、离开房间或尚未授权的成员不计入数量。
    }
  }
  return binding
}
export function recordActorSeen(
  accountId: string,
  actor: typeof channelActors.$inferSelect,
  chat: string,
  thread = '',
) {
  const updated = db
    .update(channelActors)
    .set({ accountIds: [...new Set([...actor.accountIds, accountId])], lastSeenAt: Date.now() })
    .where(eq(channelActors.id, actor.id))
    .returning()
    .get()
  db.insert(channelActorLocations).values({ actorId: actor.id, accountId, chat, thread }).onConflictDoNothing().run()
  return updated
}
