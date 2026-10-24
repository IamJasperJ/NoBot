import { channelAccountInput } from '@nobot/shared'
import { and, desc, eq, gt } from 'drizzle-orm'
import type { Hono } from 'hono'
import { z } from 'zod'
import { db, newId } from '../../../db/client'
import { channelAccounts, channelActors, channelManagedIntents } from '../../../db/schema'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { validate } from '../../../lib/validate'
import { notify } from '../../../services/social'
import { currentUser } from '../../../user-context'
import type { ChannelRuntime } from './runtime'
import { sealCredentials } from './secrets'
import { accountDTO, accountRow } from './store'

export function managedUsername(name: string) {
  const stem = name.replace(/[^a-zA-Z0-9_]/g, '').replace(/bot$/i, '') || 'nobot'
  return `${stem.padEnd(2, '_').slice(0, 29)}bot`
}
function requireManager(id: string) {
  const row = accountRow(id)
  if (row.botSnapshot.can_manage_bots !== true || !row.botUsername)
    throw new HttpError(400, 'BOT_MANAGEMENT_REQUIRED', t('在 BotFather 里为这个 bot 打开 Bot Management Mode'))
  return row
}
export function managedBotRoutes(app: Hono, runtime: () => ChannelRuntime) {
  app.post(
    '/accounts/:id/managed-bots/link',
    validate(
      'json',
      z.object({
        characterId: z.string(),
        suggestedUsername: z.string().optional(),
        suggestedName: z.string().optional(),
      }),
    ),
    (c) => {
      const manager = requireManager(c.req.param('id'))
      const input = c.req.valid('json')
      const character = runtime().host.getCharacter(input.characterId)
      const now = Date.now()
      db.insert(channelManagedIntents)
        .values({
          id: newId(),
          managerAccountId: manager.id,
          characterId: character.id,
          createdBy: currentUser().id,
          createdAt: now,
          expiresAt: now + 30 * 60000,
        })
        .run()
      const username = managedUsername(input.suggestedUsername ?? character.name)
      const name = (input.suggestedName ?? character.name).trim().slice(0, 64) || character.name.slice(0, 64)
      return c.json({
        url: `https://t.me/newbot/${encodeURIComponent(manager.botUsername!)}/${username}?name=${encodeURIComponent(name)}`,
      })
    },
  )
  const accessInput = z.object({
    restricted: z.boolean(),
    addedUserIds: z.array(z.number().int().positive().safe()).max(10).default([]),
  })
  const target = (id: string) => {
    const row = accountRow(id)
    if (!row.managedBy || !row.botId) throw new HttpError(400, 'NOT_MANAGED', t('这不是受管机器人'))
    return { row, manager: requireManager(row.managedBy) }
  }
  app.post('/accounts/:id/managed-bots/rotate-token', async (c) => {
    const { row, manager } = target(c.req.param('id'))
    const token = await runtime()
      .client(manager.config)
      .call<string>('replaceManagedBotToken', { user_id: Number(row.botId) })
    await runtime().stop(row.id, false)
    db.update(channelAccounts)
      .set({ credentials: sealCredentials({ ...row.config.credentials, token }) })
      .where(eq(channelAccounts.id, row.id))
      .run()
    return c.json(await runtime().start(row.id))
  })
  app.get('/accounts/:id/managed-bots/access', async (c) => {
    const { row, manager } = target(c.req.param('id'))
    return c.json(
      await runtime()
        .client(manager.config)
        .call('getManagedBotAccessSettings', { user_id: Number(row.botId) }),
    )
  })
  app.put('/accounts/:id/managed-bots/access', validate('json', accessInput), async (c) => {
    const { row, manager } = target(c.req.param('id'))
    const input = c.req.valid('json')
    await runtime()
      .client(manager.config)
      .call('setManagedBotAccessSettings', {
        user_id: Number(row.botId),
        is_access_restricted: input.restricted,
        added_user_ids: input.addedUserIds,
      })
    return c.json({ ok: true })
  })
}
export async function receiveManagedBot(
  runtime: ChannelRuntime,
  managerId: string,
  event: { user: { id: number }; bot: { id: number } },
) {
  const manager = requireManager(managerId)
  const actor = db
    .select()
    .from(channelActors)
    .where(
      and(
        eq(channelActors.provider, 'telegram'),
        eq(channelActors.externalId, String(event.user.id)),
        eq(channelActors.role, 'owner'),
        eq(channelActors.linkedUserId, currentUser().id),
      ),
    )
    .get()
  if (!actor?.accountIds.includes(managerId)) return
  if (
    db
      .select()
      .from(channelAccounts)
      .where(eq(channelAccounts.botId, String(event.bot.id)))
      .get()
  )
    return
  const intent = db
    .select()
    .from(channelManagedIntents)
    .where(
      and(
        eq(channelManagedIntents.managerAccountId, managerId),
        eq(channelManagedIntents.createdBy, actor.linkedUserId!),
        gt(channelManagedIntents.expiresAt, Date.now()),
      ),
    )
    .orderBy(desc(channelManagedIntents.createdAt))
    .get()
  if (!intent) return
  const character = runtime.host.getCharacter(intent.characterId)
  const token = await runtime.client(manager.config).call<string>('getManagedBotToken', { user_id: event.bot.id })
  // 主人刚通过 Telegram 原生确认专门为该角色创建 bot，因此资料跟随在这里自动确认。
  const field = { mode: 'follow-character' as const }
  const config = channelAccountInput.parse({
    ...manager.config,
    name: character.name,
    credentials: { token },
    webhookUrl: null,
    receiveMode: 'polling',
    characterMode: 'fixed',
    characterId: character.id,
    groupId: null,
    presence: {
      characterId: character.id,
      confirmed: true,
      avatar: field,
      name: field,
      description: field,
      shortDescription: field,
    },
  })
  const created = await runtime.create(config, event.bot.id)
  db.transaction(() => {
    db.update(channelAccounts).set({ managedBy: managerId }).where(eq(channelAccounts.id, created.id)).run()
    db.delete(channelManagedIntents).where(eq(channelManagedIntents.id, intent.id)).run()
  })
  await runtime.start(created.id)
  notify(
    currentUser().id,
    'channel.managed-bot.created',
    currentUser().id,
    { accountId: created.id, managerAccountId: managerId, characterId: character.id },
    Date.now(),
  )
  return accountDTO(accountRow(created.id))
}
