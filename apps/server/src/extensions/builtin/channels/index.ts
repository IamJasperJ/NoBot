import { randomBytes } from 'node:crypto'
import {
  channelAccountInput,
  channelBindingInput,
  channelPoliciesSchema,
  channelSettingsSchema,
  createRoomInput,
} from '@nobot/shared'
import { and, eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import { z } from 'zod'
import { db, getSetting, newId } from '../../../db/client'
import {
  channelAccounts,
  channelActors,
  channelDeliveries,
  channelPairings,
  channelRequests,
  personas,
} from '../../../db/schema'
import { systemDatabase } from '../../../db/system-client'
import { channelRegistry, roomMembers, rooms, users } from '../../../db/system-schema'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { validate } from '../../../lib/validate'
import { cleanupExternalUsers } from '../../../services/external-users'
import { createRoom } from '../../../services/rooms'
import { currentContext, currentUser, runAsUser } from '../../../user-context'
import { defineExtension, type ExtensionContext, SECRET_MASK } from '../../types'
import { OneBotClient } from './adapters/onebot11/client'
import { expireOneBotRequests } from './adapters/onebot11/social'
import { verifyWebhookSecret } from './adapters/telegram/receive'
import { managedBotRoutes } from './managed-bots'
import { mediaFields } from './media-settings'
import { exchangeMiniApp } from './miniapp'
import { oneBotRoutes } from './onebot-routes'
import { oneBotFields } from './onebot-settings'
import { leaveGroup, respondRequest } from './policies'
import { sealCredentials } from './secrets'
import { ChannelService } from './service'
import { accountDTO, accountRow, bindingRow, listBindings, recordActorSeen } from './store'

const services = new WeakMap<object, ChannelService>()
const pairingAttempts = new Map<string, number[]>()
export function channelService(ctx: Omit<ExtensionContext, 'chatId'>) {
  const key = currentContext().sqlite
  let value = services.get(key)
  if (!value) {
    value = new ChannelService(ctx.host, () => ({
      ...getSetting<Record<string, unknown>>('ext:channels'),
    }))
    services.set(key, value)
  }
  return value
}
const confirmInput = z.object({ confirm: z.literal(true) })
const actorPatch = z.object({
  personaName: z.string().max(120).nullable().optional(),
  personaDescription: z.string().max(8000).nullable().optional(),
  role: z.enum(['owner', 'player', 'blocked']).optional(),
  personaId: z.string().nullable().optional(),
  linkedUserId: z.string().nullable().optional(),
})
function routes(app: Hono, ctx: Omit<ExtensionContext, 'chatId'>) {
  const getService = () => channelService(ctx)
  const client = (id: string) =>
    getService().runtime.accounts.get(id)?.client ?? getService().runtime.client(accountRow(id).config)
  managedBotRoutes(app, () => getService().runtime)
  oneBotRoutes(app, () => getService().runtime)
  const presence = (id: string) => getService().runtime.presence(id)
  app.onError((error, c) =>
    c.json(
      {
        error: {
          code: error instanceof HttpError ? error.code : 'CHANNEL_FAILED',
          message: error instanceof HttpError ? error.message : t('渠道请求失败'),
        },
      },
      error instanceof HttpError ? error.status : 500,
    ),
  )
  app.get('/accounts', (c) => c.json(db.select().from(channelAccounts).all().map(accountDTO)))
  app.post('/accounts', validate('json', channelAccountInput), async (c) => {
    const config = c.req.valid('json')

    if (config.characterMode === 'fixed' && !!config.characterId === !!config.groupId)
      throw new HttpError(400, 'CHARACTER_REQUIRED', t('请先在网页选择角色'))
    if (config.characterId) ctx.host.getCharacter(config.characterId)
    if (config.policies.groupInvite === 'all' || config.policies.friendRequest === 'all')
      throw new HttpError(409, 'CONFIRM_REQUIRED', t('此操作需要主人确认'))
    config.presence.confirmed = false
    config.credentials.webhookSecret ||= randomBytes(24).toString('base64url')
    return c.json(await getService().runtime.create(config))
  })
  app.get('/accounts/:id', (c) => c.json(accountDTO(accountRow(c.req.param('id')))))
  app.patch('/accounts/:id', async (c) => {
    const id = c.req.param('id')
    const row = accountRow(id)
    const patch: unknown = await c.req.json()
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
      throw new HttpError(400, 'INVALID_INPUT', t('渠道设置无效'))
    const input = patch as Record<string, unknown>
    const parsed = channelAccountInput.safeParse({
      ...row.config,
      ...input,
      credentials:
        input.credentials === SECRET_MASK || input.credentials === undefined
          ? row.config.credentials
          : input.credentials && typeof input.credentials === 'object' && !Array.isArray(input.credentials)
            ? { ...row.config.credentials, ...input.credentials }
            : input.credentials,
    })
    if (!parsed.success) throw new HttpError(400, 'INVALID_INPUT', t('渠道设置无效'))
    const config = parsed.data
    if (config.provider !== row.config.provider) throw new HttpError(400, 'INVALID_INPUT', t('渠道设置无效'))
    const sourceChanged =
      config.characterId !== row.config.characterId ||
      config.presence.characterId !== row.config.presence.characterId ||
      config.characterMode !== row.config.characterMode
    config.presence.confirmed = row.config.presence.confirmed && !sourceChanged
    if (
      config.provider === 'telegram' &&
      (config.credentials.token !== row.config.credentials.token || config.baseUrl !== row.config.baseUrl)
    ) {
      const bot = await getService().runtime.client(config).call<{ id: number }>('getMe')
      // 允许同一只 bot 轮换凭据；更换身份必须新建账号，避免把旧成员和投递授权给另一只 bot。
      if (String(bot.id) !== row.botId) throw new HttpError(409, 'NEW_ACCOUNT_REQUIRED', t('更换机器人请新建渠道账号'))
    }
    if (
      (config.policies.groupInvite === 'all' && row.config.policies.groupInvite !== 'all') ||
      (config.policies.friendRequest === 'all' && row.config.policies.friendRequest !== 'all')
    )
      throw new HttpError(409, 'CONFIRM_REQUIRED', t('此操作需要主人确认'))
    if (config.provider === 'onebot11') {
      if (!config.connection || !(config.credentials.accessToken ?? config.credentials.token))
        throw new HttpError(400, 'INVALID_INPUT', t('渠道设置无效'))
      if (config.connection.mode === 'ws-forward') {
        const url = new URL(config.connection.url)
        if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
          throw new HttpError(400, 'INVALID_INPUT', t('渠道设置无效'))
      }
      config.receiveMode = config.connection.mode
    }
    const running = getService().runtime.accounts.has(id)
    await getService().runtime.stop(id, false)
    db.update(channelAccounts)
      .set({ ...config, credentials: sealCredentials(config.credentials) })
      .where(eq(channelAccounts.id, id))
      .run()
    if (running) await getService().runtime.start(id)
    else getService().runtime.index(id, false)
    return c.json(accountDTO(accountRow(id)))
  })
  for (const action of ['start', 'stop', 'restart'] as const)
    app.post(`/accounts/:id/${action}`, async (c) => {
      const id = c.req.param('id')
      if (action === 'stop') await getService().runtime.stop(id)
      else await getService().runtime.start(id)
      return c.json(accountDTO(accountRow(id)))
    })
  app.delete('/accounts/:id', async (c) => {
    const id = c.req.param('id')
    await getService().runtime.stop(id)
    db.delete(channelAccounts).where(eq(channelAccounts.id, id)).run()
    systemDatabase()
      .delete(channelRegistry)
      .where(and(eq(channelRegistry.userHandle, currentUser().handle), eq(channelRegistry.accountId, id)))
      .run()
    cleanupExternalUsers(currentUser().id)
    return c.json({ ok: true })
  })
  app.get('/accounts/:id/presence/preview', async (c) => c.json(await presence(c.req.param('id')).preview()))
  app.post('/accounts/:id/presence/apply', validate('json', confirmInput), async (c) =>
    c.json(await presence(c.req.param('id')).apply(true)),
  )
  app.post('/accounts/:id/presence/sync', async (c) => c.json(await presence(c.req.param('id')).sync(true)))
  app.put(
    '/accounts/:id/policies',
    validate('json', z.object({ policies: channelPoliciesSchema, confirm: z.boolean().optional() })),
    (c) => {
      const id = c.req.param('id'),
        row = accountRow(id),
        input = c.req.valid('json')
      if (
        ((input.policies.groupInvite === 'all' && row.config.policies.groupInvite !== 'all') ||
          (input.policies.friendRequest === 'all' && row.config.policies.friendRequest !== 'all')) &&
        !input.confirm
      )
        throw new HttpError(409, 'CONFIRM_REQUIRED', t('此操作需要主人确认'))
      db.update(channelAccounts).set({ policies: input.policies }).where(eq(channelAccounts.id, id)).run()
      return c.json(accountDTO(accountRow(id)))
    },
  )
  app.get('/requests', (c) => {
    expireOneBotRequests()
    return c.json(
      db
        .select()
        .from(channelRequests)
        .where(c.req.query('accountId') ? eq(channelRequests.accountId, c.req.query('accountId')!) : undefined)
        .all()
        .map(({ flag: _, subType: __, ...request }) => request),
    )
  })
  for (const action of ['approve', 'reject', 'block'] as const)
    app.post(`/requests/:id/${action}`, async (c) => {
      const request = db
        .select()
        .from(channelRequests)
        .where(eq(channelRequests.id, c.req.param('id')))
        .get()
      if (!request) throw new HttpError(404, 'NOT_FOUND', t('渠道请求不存在'))
      await respondRequest(request.id, action, client(request.accountId))
      return c.json({ ok: true })
    })
  app.post('/bindings', validate('json', channelBindingInput), async (c) => {
    const input = c.req.valid('json')
    accountRow(input.accountId)
    if (!input.title) {
      const location = await client(input.accountId).call<{ title?: string; first_name?: string; last_name?: string }>(
        'getChat',
        { chat_id: input.chat },
      )
      input.title = location.title ?? [location.first_name, location.last_name].filter(Boolean).join(' ')
    }
    const chat = ctx.host.getChatInfo(input.chatId).chat
    let roomId = input.roomId
    const existing = systemDatabase().select().from(rooms).where(eq(rooms.chatId, chat.id)).get()
    if (existing && existing.hostUserId !== currentUser().id)
      throw new HttpError(403, 'FORBIDDEN', t('没有渠道操作权限'))
    if (input.source === 'attached' || (input.scope === 'group' && input.source !== 'account-shared'))
      roomId = existing?.id ?? createRoom(createRoomInput.parse({ name: chat.title, chatId: chat.id })).id
    if (roomId) {
      const room = systemDatabase().select().from(rooms).where(eq(rooms.id, roomId)).get()
      if (!room || room.hostUserId !== currentUser().id || room.chatId !== chat.id)
        throw new HttpError(403, 'FORBIDDEN', t('没有渠道操作权限'))
    }
    const binding = {
      ...input,
      roomId,
      id: newId(),
      createdBy: currentUser().id,
      lastActivityAt: Date.now(),
      idleWarnedAt: null,
    }
    getService().saveBinding(binding)
    return c.json(bindingRow(binding.id))
  })
  app.get('/bindings', (c) => c.json(listBindings(c.req.query('accountId'))))
  app.get('/bindings/:id', (c) => c.json(bindingRow(c.req.param('id'))))
  app.patch('/bindings/:id', validate('json', channelBindingInput.partial()), async (c) => {
    const binding = bindingRow(c.req.param('id'))
    const patch = c.req.valid('json')
    // Zod 会在 partial 中填入默认值；PATCH 只能使用请求实际携带的字段，避免清空平台名称。
    const supplied = await c.req.json<Record<string, unknown>>()
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
      if (!Object.hasOwn(supplied, key)) delete patch[key]
    }
    const updated = { ...binding, ...patch, accountId: binding.accountId }
    // 更换位置会使旧投递与回调失效，位置键只允许创建时指定。
    if (updated.chat !== binding.chat || updated.scope !== binding.scope)
      throw new HttpError(400, 'INVALID_INPUT', t('渠道设置无效'))
    if (updated.source === 'attached') {
      const room = systemDatabase().select().from(rooms).where(eq(rooms.chatId, updated.chatId)).get()
      if (room && room.hostUserId !== currentUser().id) throw new HttpError(403, 'FORBIDDEN', t('没有渠道操作权限'))
      updated.roomId =
        room?.id ??
        createRoom(
          createRoomInput.parse({ name: ctx.host.getChatInfo(updated.chatId).chat.title, chatId: updated.chatId }),
        ).id
    }
    if (updated.roomId) {
      const room = systemDatabase().select().from(rooms).where(eq(rooms.id, updated.roomId)).get()
      if (!room || room.hostUserId !== currentUser().id || room.chatId !== updated.chatId)
        throw new HttpError(403, 'FORBIDDEN', t('没有渠道操作权限'))
    }
    getService().saveBinding(updated)
    return c.json(bindingRow(updated.id))
  })
  app.post('/bindings/:id/disable', (c) => {
    const binding = bindingRow(c.req.param('id'))
    getService().saveBinding({ ...binding, state: 'disabled' })
    return c.json({ ok: true })
  })
  app.post('/bindings/:id/leave', validate('json', confirmInput), async (c) => {
    const binding = bindingRow(c.req.param('id'))
    if (binding.scope !== 'group') throw new HttpError(400, 'INVALID_INPUT', t('渠道设置无效'))
    await leaveGroup(binding.accountId, binding.chat, client(binding.accountId))
    return c.json({ ok: true })
  })
  app.get('/bindings/:id/settings', (c) => c.json(getService().settings(bindingRow(c.req.param('id')))))
  app.get('/actors', (c) => c.json(db.select().from(channelActors).all()))
  app.patch('/actors/:id', validate('json', actorPatch), (c) => {
    const patch = c.req.valid('json')
    const actor = db
      .select()
      .from(channelActors)
      .where(eq(channelActors.id, c.req.param('id')))
      .get()
    if (!actor) throw new HttpError(404, 'NOT_FOUND', t('渠道成员不存在'))
    if (patch.personaId) {
      const persona = db.select().from(personas).where(eq(personas.id, patch.personaId)).get()
      if (!persona) throw new HttpError(404, 'NOT_FOUND', t('人设'))
      patch.personaName ??= persona.name
      patch.personaDescription ??= persona.description
    } else if (patch.personaId === null) {
      if (patch.personaName === undefined) patch.personaName = null
      if (patch.personaDescription === undefined) patch.personaDescription = null
    }
    if (patch.role === 'owner' && (patch.linkedUserId ?? actor.linkedUserId) !== currentUser().id)
      throw new HttpError(403, 'FORBIDDEN', t('没有渠道操作权限'))
    if (patch.linkedUserId) {
      // 不允许把任意平台身份直接提升成其他真实用户；配对确认只绑定当前登录用户。
      if (patch.linkedUserId !== currentUser().id) throw new HttpError(403, 'FORBIDDEN', t('没有渠道操作权限'))
    }
    return c.json(db.update(channelActors).set(patch).where(eq(channelActors.id, actor.id)).returning().get())
  })
  app.post(
    '/pairings/confirm',
    validate('json', z.object({ code: z.string(), ownerHandle: z.string().optional() })),
    (c) => {
      const input = c.req.valid('json'),
        requester = currentUser()
      const recent = (pairingAttempts.get(requester.id) ?? []).filter((at) => Date.now() - at < 60000)
      if (recent.length >= 10) throw new HttpError(429, 'RATE_LIMITED', t('消息发送过于频繁，请稍后重试'))
      pairingAttempts.set(requester.id, [...recent, Date.now()])
      const owner = input.ownerHandle
        ? systemDatabase()
            .select()
            .from(users)
            .where(and(eq(users.handle, input.ownerHandle), eq(users.kind, 'normal'), eq(users.disabled, false)))
            .get()
        : requester
      if (!owner) throw new HttpError(400, 'PAIRING_EXPIRED', t('配对码无效或已过期'))
      return runAsUser(owner, () => {
        if (getSetting<Record<string, boolean>>('extensionsEnabled')?.channels !== true)
          throw new HttpError(400, 'PAIRING_EXPIRED', t('配对码无效或已过期'))
        const pairing = db.select().from(channelPairings).where(eq(channelPairings.code, input.code)).get()
        if (!pairing || pairing.expiresAt <= Date.now())
          throw new HttpError(400, 'PAIRING_EXPIRED', t('配对码无效或已过期'))
        const account = accountRow(pairing.accountId)
        const actor = db
          .select()
          .from(channelActors)
          .where(
            and(eq(channelActors.provider, account.config.provider), eq(channelActors.externalId, pairing.externalId)),
          )
          .get()
        if (actor?.role === 'blocked' || (actor?.linkedUserId && actor.linkedUserId !== requester.id))
          throw new HttpError(403, 'FORBIDDEN', t('没有渠道操作权限'))
        const values = {
          provider: account.config.provider,
          externalId: pairing.externalId,
          displayName: pairing.displayName,
          role: owner.id === requester.id ? ('owner' as const) : ('player' as const),
          linkedUserId: requester.id,
          externalUserId: null,
          dmChatId: pairing.externalId,
        }
        const result = db.transaction(() => {
          const value = actor
            ? db.update(channelActors).set(values).where(eq(channelActors.id, actor.id)).returning().get()
            : db
                .insert(channelActors)
                .values({ id: newId(), ...values })
                .returning()
                .get()
          db.delete(channelPairings).where(eq(channelPairings.code, input.code)).run()
          return recordActorSeen(pairing.accountId, value, pairing.externalId)
        })
        if (actor?.externalUserId)
          for (const room of systemDatabase().select().from(rooms).where(eq(rooms.hostUserId, owner.id)).all()) {
            systemDatabase()
              .update(roomMembers)
              .set({ state: 'left' })
              .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, actor.externalUserId)))
              .run()
          }
        return c.json(result)
      })
    },
  )
  app.get('/log', (c) => c.json(getSetting('channels:log') ?? []))
  app.post(
    '/accounts/:id/test-send',
    validate('json', z.object({ chat: z.string(), text: z.string().min(1).max(4096) })),
    async (c) => {
      const input = c.req.valid('json')
      await client(c.req.param('id')).call('sendMessage', { chat_id: input.chat, text: input.text })
      return c.json({ ok: true })
    },
  )
  app.post(
    '/bindings/:id/native',
    validate(
      'json',
      z.discriminatedUnion('action', [
        z.object({ action: z.literal('pin'), messageId: z.number().int(), confirm: z.literal(true) }),
        z.object({ action: z.literal('unpin'), messageId: z.number().int(), confirm: z.literal(true) }),
        z.object({ action: z.literal('topic'), name: z.string().min(1).max(128), confirm: z.literal(true) }),
        z.object({ action: z.literal('title'), title: z.string().min(1).max(128), confirm: z.literal(true) }),
        z.object({ action: z.literal('description'), description: z.string().max(255), confirm: z.literal(true) }),
      ]),
    ),
    async (c) => {
      const binding = bindingRow(c.req.param('id')),
        input = c.req.valid('json'),
        api = client(binding.accountId)
      const row = accountRow(binding.accountId)
      const member = await api.call<{
        status: string
        can_change_info?: boolean
        can_manage_topics?: boolean
        can_pin_messages?: boolean
      }>('getChatMember', { chat_id: binding.chat, user_id: row.botId })
      if (!['administrator', 'creator'].includes(member.status))
        throw new HttpError(403, 'FORBIDDEN', t('机器人缺少群管理权限'))
      if (input.action === 'pin' || input.action === 'unpin') {
        if (!member.can_pin_messages) throw new HttpError(403, 'FORBIDDEN', t('机器人缺少群管理权限'))
        const delivered = db
          .select()
          .from(channelDeliveries)
          .where(eq(channelDeliveries.bindingId, binding.id))
          .all()
          .some((d) =>
            d.parts.some((part) => part.externalChat === binding.chat && part.externalId === String(input.messageId)),
          )
        if (!delivered) throw new HttpError(404, 'NOT_FOUND', t('消息'))
        return c.json(
          await api.call(input.action === 'pin' ? 'pinChatMessage' : 'unpinChatMessage', {
            chat_id: binding.chat,
            message_id: input.messageId,
          }),
        )
      }
      if (input.action === 'topic') {
        if (!member.can_manage_topics) throw new HttpError(403, 'FORBIDDEN', t('机器人缺少群管理权限'))
        const topic = await api.call<{ message_thread_id: number }>('createForumTopic', {
          chat_id: binding.chat,
          name: input.name,
        })
        const old = ctx.host.getChatInfo(binding.chatId).chat
        const chat = ctx.host.createChat(old.groupId ? { groupId: old.groupId } : { characterId: old.characterId! })
        const room = createRoom(createRoomInput.parse({ name: input.name, chatId: chat.id }))
        const next = {
          ...binding,
          id: newId(),
          source: 'new' as const,
          isolation: 'per-topic' as const,
          title: input.name,
          thread: String(topic.message_thread_id),
          actor: '',
          chatId: chat.id,
          roomId: room.id,
          lastActivityAt: Date.now(),
          idleWarnedAt: null,
        }
        getService().saveBinding(next, input.name)
        return c.json({ topic, binding: bindingRow(next.id) })
      }
      if (!member.can_change_info) throw new HttpError(403, 'FORBIDDEN', t('机器人缺少群管理权限'))
      return c.json(
        await api.call(input.action === 'title' ? 'setChatTitle' : 'setChatDescription', {
          chat_id: binding.chat,
          ...(input.action === 'title' ? { title: input.title } : { description: input.description }),
        }),
      )
    },
  )
}
export default defineExtension({
  id: 'channels',
  name: '聊天平台渠道',
  description: '把聊天平台接到 NoBot 会话和房间',
  version: '0.1.0',
  enabledByDefault: false,
  defaultSettings: {
    publicBaseUrl: '',
    miniAppAuthMaxAgeSeconds: 600,
    ...Object.fromEntries(Object.entries(channelSettingsSchema.parse({})).filter(([key]) => key !== 'echoTranscript')),
  },
  settingsSchema: [
    ...mediaFields,
    ...oneBotFields,
    {
      type: 'string',
      key: 'publicBaseUrl',
      label: 'HTTPS 公网地址',
      hint: 'Mini App 和 webhook 共用的 HTTPS 公网源地址',
    },
    { type: 'number', key: 'miniAppAuthMaxAgeSeconds', label: 'Mini App 验签有效秒数', min: 1, max: 600 },
    { type: 'boolean', key: 'miniAppButton', label: 'VN 舞台按钮' },
    { type: 'boolean', key: 'miniAppMenuButton', label: 'VN 菜单按钮' },
    { type: 'boolean', key: 'stream', label: '流式输出' },
    { type: 'number', key: 'streamIntervalMs', label: '流式更新间隔', min: 250, max: 60000 },
    {
      type: 'select',
      key: 'thinking',
      label: '渠道思考过程',
      options: [
        { value: 'omit', label: '隐藏思考过程' },
        { value: 'fold', label: '折叠思考过程' },
      ],
    },
    { type: 'boolean', key: 'regenerateButton', label: '重新生成按钮' },
    { type: 'boolean', key: 'previousButton', label: '上一候选按钮' },
    { type: 'boolean', key: 'nextButton', label: '下一候选按钮' },
    { type: 'boolean', key: 'continueButton', label: '续写按钮' },
    { type: 'boolean', key: 'deleteButton', label: '删除消息按钮' },
    {
      type: 'select',
      key: 'queueMode',
      label: '渠道连发处理',
      options: [
        { value: 'merge', label: '排队合并' },
        { value: 'interrupt', label: '打断重来' },
      ],
    },
    { type: 'number', key: 'actorRateLimit', label: '每位成员每分钟消息上限', min: 1, max: 1000 },
    { type: 'boolean', key: 'mirrorWebMessages', label: '同步网页消息' },
    { type: 'boolean', key: 'personaPrefix', label: '同步时显示人设名字' },
    { type: 'boolean', key: 'deleteSync', label: '同步平台删除' },
    { type: 'boolean', key: 'mentionOnTurn', label: '回合提示时提及成员' },
    { type: 'boolean', key: 'reactions', label: '表情回应' },
    { type: 'number', key: 'reactionCooldownMs', label: '表情回应冷却毫秒', min: 1000 },
    { type: 'number', key: 'reactionDailyBudget', label: '表情回应每日预算', min: 0, max: 1000 },
  ],
  routes,
  publicRoutes(app, ctx) {
    app.get('/:id/onebot', async (c, next) => {
      const row = accountRow(c.req.param('id'))
      const entry = channelService(ctx).runtime.accounts.get(row.id)
      if (
        row.config.provider !== 'onebot11' ||
        row.config.connection?.mode !== 'ws-reverse' ||
        !(entry?.client instanceof OneBotClient) ||
        entry.client.transport.paused
      )
        return c.json({ ok: false }, 404)
      if (
        !verifyWebhookSecret(
          c.req.header('Authorization'),
          `Bearer ${row.config.credentials.accessToken ?? row.config.credentials.token}`,
        )
      )
        return c.json({ ok: false }, 403)
      const owner = currentUser()
      const transport = entry.client.transport
      let socket: import('./adapters/onebot11/transport').OneBotSocket | undefined
      return upgradeWebSocket(() => ({
        onOpen: (_event, ws) =>
          runAsUser(owner, () => {
            socket = ws
            transport.attach(ws)
          }),
        onMessage: (event) =>
          runAsUser(owner, () =>
            transport.receive(
              typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer),
            ),
          ),
        onClose: () => runAsUser(owner, () => transport.detach(socket)),
      }))(c, next)
    })
    app.post(
      '/miniapp/session',
      validate('json', z.object({ initData: z.string().max(16384).default(''), start: z.string().min(1).max(64) })),
      (c) => c.json(exchangeMiniApp(c, c.req.valid('json'))),
    )
    app.post('/:id', async (c) => {
      const id = c.req.param('id'),
        row = accountRow(id)
      if (
        row.config.receiveMode !== 'webhook' ||
        !verifyWebhookSecret(
          c.req.header('X-Telegram-Bot-Api-Secret-Token'),
          row.config.credentials.webhookSecret ?? '',
        )
      )
        return c.json({ ok: false }, 403)
      const value = channelService(ctx)
      if (!value.runtime.accounts.has(id)) return c.json({ ok: false }, 404)
      await value.receive(id, await c.req.json())
      return c.json({ ok: true })
    })
  },
  async startBackground(ctx, signal) {
    const value = channelService(ctx)
    const key = currentContext().sqlite
    signal.addEventListener(
      'abort',
      () => {
        value.dispose()
        services.delete(key)
      },
      { once: true },
    )
    await value.runtime.resume()
  },
  dispose() {
    const key = currentContext().sqlite
    services.get(key)?.dispose()
    services.delete(key)
  },
  hooks: {
    onEvent(event, _ctx) {
      services.get(currentContext().sqlite)?.onEvent(event)
    },
  },
})
