import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelProviderDefinition, ChannelProviderIO } from '../src/extensions/sdk'

test('渠道平台：注册、批准、入站、生成、查询、投递与生命周期', async () => {
  if (!process.env.CHANNEL_PROVIDER_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, CHANNEL_PROVIDER_CHILD: '1', MOCK_LLM_FETCH: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timeout = setTimeout(() => child.kill(), 45000)
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, out + err).toBe(0)
    } finally {
      clearTimeout(timeout)
    }
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'nobot-provider-'))
  process.env.DATA_DIR = directory
  delete (globalThis as typeof globalThis & { __NOBOT_TEST_USER__?: string }).__NOBOT_TEST_USER__
  const { eq } = await import('drizzle-orm')
  const { systemDatabase } = await import('../src/db/system-client')
  const { users } = await import('../src/db/system-schema')
  const { runAsUser, closeUserDatabase } = await import('../src/user-context')
  const { db, getSetting, newId } = await import('../src/db/client')
  const { channelAccounts, channelRequests, channelDeliveries, messages } = await import('../src/db/schema')
  const { createExtensionHost } = await import('../src/extensions/host')
  const registry = await import('../src/extensions/registry')
  const { channelService } = await import('../src/extensions/builtin/channels')
  const { extensionChannels } = await import('../src/extensions/builtin/channels/provider-host')
  const { accountRow, accountDTO, listBindings } = await import('../src/extensions/builtin/channels/store')
  const { respondRequest } = await import('../src/extensions/builtin/channels/policies')
  const { createCharacter } = await import('../src/services/characters')
  const { createApiPreset } = await import('../src/services/connections')
  const { apiPresetInput } = await import('@nobot/shared')
  const { mockLlm } = await import('./helpers/mockLlm')
  const { ChannelSendError } = await import('../src/extensions/sdk')
  const { PluginChannelClient } = await import('../src/extensions/builtin/channels/adapters/plugin')
  const { loadMessage } = await import('../src/services/chats')
  const other = { id: 'provider-other', handle: 'provider-other', name: 'Other', isAdmin: false }
  const owner = { id: 'provider-owner', handle: 'provider-owner', name: 'Owner', isAdmin: true }
  systemDatabase()
    .insert(users)
    .values({ ...owner, passwordHash: 'unused', createdAt: Date.now() })
    .run()
  systemDatabase()
    .insert(users)
    .values({ ...other, passwordHash: 'unused', createdAt: Date.now() })
    .run()
  const run = <T>(fn: () => T) => runAsUser(owner, fn)
  const host = createExtensionHost(registry.emitServerEvent)
  const model = mockLlm()
  let io!: ChannelProviderIO
  let starts = 0
  const sends: { chatId: string; text: string }[] = []
  let behavior: 'ok' | 'not-sent' | 'unknown' | 'error' | 'never-sent' | 'captcha' | 'no-delay' = 'ok'
  let failures = 0
  let pauseOnFailure = false
  let sendGate: Promise<void> | undefined
  let releaseSend: (() => void) | undefined
  let readyOnStart = true
  const definition: ChannelProviderDefinition = {
    id: 'dm',
    name: 'Test DM',
    scopes: ['private'],
    canInitiate: false,
    limits: { maxTextLength: 5, minIntervalMs: 0, perMinute: 120 },
    media: { inboundImages: true, outboundImages: false, voice: false },
    accountFields: [],
    defaults: { newLocation: { private: 'approve' } },
    promptHint: 'This is a test DM. Reply briefly in plain text. Write in the same language as the conversation.',
    start(_account, value) {
      starts++
      io = value
      if (readyOnStart) io.status('online')
    },
    async send(_account, message) {
      await sendGate
      failures++
      if (behavior === 'captcha' && failures <= 5) {
        io.status(['paused', 'offline', 'connecting'][failures % 3] as 'paused' | 'offline' | 'connecting', 'Captcha')
        throw new ChannelSendError('not-sent', 'captcha')
      }
      if (behavior === 'no-delay') throw new ChannelSendError('not-sent', 'captcha')
      if (pauseOnFailure && failures === 1) io.status('paused', 'Budget paused')
      if (behavior === 'never-sent') throw new ChannelSendError('not-sent', 'BUDGET', { retryAfterMs: 1 })
      if (behavior === 'error') throw new Error('private detail')
      if (behavior === 'not-sent' && failures < 3) throw new ChannelSendError('not-sent', 'BUDGET', { retryAfterMs: 1 })
      if (behavior === 'unknown')
        throw Object.assign(new Error('private detail'), { name: 'ChannelSendError', kind: 'unknown' })
      sends.push(message)
      return { id: `sent-${sends.length}` }
    },
  }
  const signal = new AbortController()
  let service!: ReturnType<typeof channelService>
  const api = run(() => extensionChannels('test-plugin', host, true, signal.signal, 'Test Plugin'))
  const emit = (id: string, text: string, extra = {}) =>
    io.emit({
      id,
      text,
      from: { id: 'visitor', name: 'Visitor' },
      chat: { id: 'visitor', title: 'Visitor' },
      sentAt: Date.now(),
      ...extra,
    })
  const settle = async (condition: () => boolean) => {
    for (let n = 0; n < 200 && !condition(); n++) await Bun.sleep(10)
    expect(condition()).toBe(true)
  }
  try {
    await run(async () => {
      service = channelService({ host })
      registry.updateExtension('channels', { enabled: true })
      expect(() =>
        extensionChannels('no-permission', host, false, signal.signal).registerProvider(definition),
      ).toThrow()
      const registration = api.registerProvider(definition)
      api.registerProvider({
        ...definition,
        id: 'secret',
        accountFields: [{ type: 'string', key: 'password', label: 'Password', secret: true }],
      })
      // 零字段平台视为扩展托管账号；有字段的平台需手动添加。
      const { listProviders } = await import('../src/extensions/builtin/channels/providers')
      const listed = listProviders()
      expect(listed.find((p) => p.id === 'test-plugin.dm')).toMatchObject({
        extensionId: 'test-plugin',
        extensionName: 'Test Plugin',
        managed: true,
      })
      expect(listed.find((p) => p.id === 'test-plugin.secret')?.managed).toBe(false)
      const secret = await service.runtime.create(
        (await import('@nobot/shared')).channelAccountInput.parse({
          provider: 'test-plugin.secret',
          name: 'Secret',
          credentials: { password: 'CONFIG_SECRET' },
        }),
      )
      expect(accountRow(secret.id).credentials).not.toContain('CONFIG_SECRET')
      expect(accountRow(secret.id).config.credentials.password).toBe('CONFIG_SECRET')
      expect(JSON.stringify(accountDTO(accountRow(secret.id)))).not.toContain('CONFIG_SECRET')
      const character = createCharacter({ name: 'Alice', firstMes: 'GREETING_MUST_NOT_EXIST' })
      const result = await api.ensureAccount('dm', { name: 'DM', characterId: character.id })
      expect(result.characterFollowed).toBe(true)
      expect(accountRow(result.accountId).providerState.ensuredCharacterId).toBe(character.id)
      expect(await api.ensureAccount('dm', { name: 'Ignored' })).toEqual({ ...result, characterFollowed: false })
      const nextCharacter = createCharacter({ name: 'Bob' })
      expect(await api.ensureAccount('dm', { name: 'Ignored', characterId: nextCharacter.id })).toEqual(result)
      expect(accountRow(result.accountId).characterId).toBe(nextCharacter.id)
      expect(accountRow(result.accountId).providerState.ensuredCharacterId).toBe(nextCharacter.id)
      db.update(channelAccounts)
        .set({ characterId: character.id })
        .where(eq(channelAccounts.id, result.accountId))
        .run()
      expect(
        (await api.ensureAccount('dm', { name: 'Ignored', characterId: nextCharacter.id })).characterFollowed,
      ).toBe(false)
      expect(accountRow(result.accountId).characterId).toBe(character.id)
      db.update(channelAccounts).set({ characterMode: 'generic' }).where(eq(channelAccounts.id, result.accountId)).run()
      expect(
        (await api.ensureAccount('dm', { name: 'Ignored', characterId: nextCharacter.id })).characterFollowed,
      ).toBe(false)
      db.update(channelAccounts).set({ characterMode: 'fixed' }).where(eq(channelAccounts.id, result.accountId)).run()
      expect(accountRow(result.accountId).name).toBe('DM')
      const startsBefore = starts
      await Promise.all([service.runtime.start(result.accountId), service.runtime.start(result.accountId)])
      expect(starts).toBe(startsBefore + 1)
      expect(accountRow(result.accountId).config.policies.newLocation.private).toBe('approve')
      expect(accountDTO(accountRow(result.accountId)).providerName).toBe('Test DM')
      await expect(api.ensureAccount('other', { name: 'No' })).rejects.toHaveProperty(
        'code',
        'CHANNEL_PERMISSION_REQUIRED',
      )
      const client = service.runtime.accounts.get(result.accountId)!.client as InstanceType<typeof PluginChannelClient>
      client.sleep = async () => {}
      // 接收器持锁时 send 被阻塞，批准请求必须先落库并让 emit 返回。
      sendGate = new Promise<void>((resolve) => {
        releaseSend = resolve
      })
      const emitWhileLocked = emit('pending', 'hello')
      expect(await Promise.race([emitWhileLocked.then(() => 'saved'), Bun.sleep(500).then(() => 'timeout')])).toBe(
        'saved',
      )
      expect(db.select().from(channelRequests).get()?.state).toBe('pending')
      releaseSend!()
      sendGate = undefined
      await client.call('sendMessage', { chat_id: 'visitor', text: 'drain' })
      const request = db.select().from(channelRequests).get()!
      expect(request.state).toBe('pending')
      createApiPreset(apiPresetInput.parse({ name: 'Mock', baseUrl: model.url, model: 'mock-one' }))
      model.setScript(() => ({ text: 'approved', delayMs: 1 }))
      io.setOwner('visitor')
      await respondRequest(request.id, 'approve', client)
      const approvedBinding = listBindings(result.accountId).find((binding) => binding.chat === 'visitor')!
      await host.waitIdle(approvedBinding.chatId, 5000)
      await client.call('sendMessage', { chat_id: 'visitor', text: 'drain' })
      // 未配对玩家获批后走真实房间生成，快于轮询周期的模型也必须回复。
      const visitor = (id: string, text: string) =>
        io.emit({
          id,
          text,
          from: { id: 'player', name: 'Player' },
          chat: { id: 'player', title: 'Player' },
          sentAt: Date.now(),
        })
      model.setScript(() => ({ text: 'player reply', delayMs: 1 }))
      const png = new Uint8Array(
        await (await import('sharp'))
          .default({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } })
          .png()
          .toBuffer(),
      )
      await visitor('player-request', 'Alice?')
      await io.emit({
        id: 'player-image',
        text: 'earlier image',
        context: 'Approval context',
        sentAt: 100,
        from: { id: 'player', name: 'Player' },
        chat: { id: 'player', title: 'Player' },
        images: [{ bytes: png, mime: 'image/png' }],
      })
      await io.emit({
        id: 'player-equal',
        text: 'equal time',
        sentAt: 100,
        from: { id: 'player', name: 'Player' },
        chat: { id: 'player', title: 'Player' },
      })
      const playerRequest = db
        .select()
        .from(channelRequests)
        .all()
        .find((request) => request.chat === 'player')!
      const pendingApproval = getSetting<{ event: { text: string; photo?: unknown }; images: string[] }[]>(
        `channels:request:${playerRequest.id}`,
      )!
      expect(pendingApproval).toHaveLength(3)
      expect(pendingApproval[1]!.images).toHaveLength(1)
      expect(pendingApproval[1]!.event.photo).toBeUndefined()
      expect(client.files.size).toBe(0)
      const requestsBeforeApproval = model.requests.length
      await respondRequest(playerRequest.id, 'approve', client)
      const replayBinding = listBindings(result.accountId).find((binding) => binding.chat === 'player')!
      await settle(() =>
        host
          .getChatInfo(replayBinding.chatId, 100)
          .messages.some((message) => message.role === 'assistant' && message.status !== 'streaming'),
      )
      await host.waitIdle(replayBinding.chatId, 5000)
      await client.call('sendMessage', { chat_id: 'visitor', text: 'drain' })
      const replayed = host.getChatInfo(replayBinding.chatId, 100).messages
      expect(replayed.filter((message) => message.role === 'user').map((message) => message.content)).toEqual([
        'earlier image',
        'equal time',
        'Alice?',
      ])
      expect(replayed[0]!.meta.context).toBe('Approval context')
      expect(replayed[0]!.meta.images).toHaveLength(1)
      expect(replayed.some((message) => message.content.includes('GREETING_MUST_NOT_EXIST'))).toBe(false)
      expect(model.requests.length - requestsBeforeApproval).toBe(1)
      expect(getSetting(`channels:request:${playerRequest.id}`)).toBeNull()
      await visitor('player-first', 'Alice?')
      const playerBinding = listBindings(result.accountId).find((binding) => binding.chat === 'player')!
      const rooms = await import('../src/services/rooms')
      rooms.updateRoom(playerBinding.roomId!, { turnMode: 'every' })
      const playerBefore = sends.filter((message) => message.chatId === 'player').length
      await visitor('player-next', 'Alice?')
      await settle(() => sends.filter((message) => message.chatId === 'player').length >= playerBefore + 3)
      expect(
        sends
          .filter((message) => message.chatId === 'player')
          .slice(playerBefore)
          .map((message) => message.text)
          .join(''),
      ).toBe('player reply')
      expect(api.lookup(playerBinding.chatId)?.ownerPresent).toBe(false)
      await host.waitIdle(playerBinding.chatId, 5000)
      rooms.updateRoom(playerBinding.roomId!, { turnMode: 'host' })
      await visitor('player-pending', 'pending for a later round')
      // 主持人模式下由网页触发的这一轮仍是在答复未回复的入站消息，允许投递。
      const proactiveBefore = sends.length
      host.trigger(playerBinding.chatId)
      await host.waitIdle(playerBinding.chatId, 5000)
      await settle(() => sends.length > proactiveBefore)
      expect(sends.length).toBeGreaterThan(proactiveBefore)
      // 新 service 没有旧任务订阅和认领状态，投递许可仍由消息树恢复。
      const { ChannelService } = await import('../src/extensions/builtin/channels/service')
      const fresh = new ChannelService(host, () => ({}))
      fresh.runtime.accounts.set(result.accountId, {
        ...service.runtime.accounts.get(result.accountId)!,
        controller: new AbortController(),
      })
      try {
        const root = newId()
        const firstReply = newId()
        const now = Date.now()
        db.insert(messages)
          .values([
            {
              id: root,
              chatId: playerBinding.chatId,
              parentId: null,
              role: 'user',
              content: 'restart input',
              meta: { clientMessageId: `test-plugin.dm:player:restart` },
              createdAt: now,
            },
            {
              id: firstReply,
              chatId: playerBinding.chatId,
              parentId: root,
              role: 'assistant',
              content: 'restored',
              createdAt: now + 1000,
            },
          ])
          .run()
        const restoredBefore = sends.length
        await fresh.deliver(playerBinding, loadMessage(firstReply))
        expect(sends.length).toBeGreaterThan(restoredBefore)
        const sameBranch = newId()
        const sibling = newId()
        const expired = newId()
        db.insert(messages)
          .values([
            {
              id: sameBranch,
              chatId: playerBinding.chatId,
              parentId: firstReply,
              role: 'tool',
              content: 'tool protocol',
              meta: { channelVoice: { bindingIds: [playerBinding.id], style: 'only', text: 'tool followup' } },
              createdAt: now + 2000,
            },
            {
              id: sibling,
              chatId: playerBinding.chatId,
              parentId: root,
              role: 'assistant',
              content: 'regenerated',
              createdAt: now + 3000,
            },
            {
              id: expired,
              chatId: playerBinding.chatId,
              parentId: sameBranch,
              role: 'assistant',
              content: 'expired',
              createdAt: now + 30 * 60000 + 1,
            },
          ])
          .run()
        const toolBefore = sends.length
        await fresh.deliver(playerBinding, loadMessage(sameBranch))
        expect(sends.length).toBeGreaterThan(toolBefore)
        const boundary = newId()
        db.insert(messages)
          .values({
            id: boundary,
            chatId: playerBinding.chatId,
            parentId: sameBranch,
            role: 'assistant',
            content: 'boundary',
            createdAt: now + 30 * 60000,
          })
          .run()
        const boundaryBefore = sends.length
        await fresh.deliver(playerBinding, loadMessage(boundary))
        expect(sends.length).toBeGreaterThan(boundaryBefore)
        const blockedBefore = sends.length
        await fresh.deliver(playerBinding, loadMessage(sibling))
        await fresh.deliver(playerBinding, loadMessage(expired))
        expect(sends.length).toBe(blockedBefore)
      } finally {
        fresh.dispose()
      }
      // 等待期间仅保留最近二十条；拒绝和拉黑都清掉持久化内容。
      for (const action of ['reject', 'block'] as const) {
        for (let i = 0; i < 22; i++)
          await io.emit({
            id: `${action}-${i}`,
            text: `pending ${i}`,
            sentAt: i,
            from: { id: action, name: action },
            chat: { id: action, title: action },
          })
        const pendingRequest = db
          .select()
          .from(channelRequests)
          .all()
          .find((item) => item.chat === action)!
        const buffered = getSetting<{ event: { text: string } }[]>(`channels:request:${pendingRequest.id}`)!
        expect(buffered).toHaveLength(20)
        expect(buffered[0]!.event.text).toBe('pending 2')
        await respondRequest(pendingRequest.id, action, client)
        expect(getSetting(`channels:request:${pendingRequest.id}`)).toBeNull()
      }
      await client.call('sendMessage', { chat_id: 'visitor', text: 'drain' })
      // 主人通路验证 context；随后取消主人，验证禁止主动发送。
      io.setOwner('visitor')
      model.setScript(() => ({ text: 'abcdefghijklmnop', delayMs: 1 }))
      const before = sends.length
      sendGate = new Promise<void>((resolve) => {
        releaseSend = resolve
      })
      const inboundWhileLocked = emit('inbound', 'hello', { context: 'Private platform context' })
      expect(await Promise.race([inboundWhileLocked.then(() => 'saved'), Bun.sleep(500).then(() => 'timeout')])).toBe(
        'saved',
      )
      await Bun.sleep(30)
      expect(sends.length).toBe(before)
      releaseSend!()
      sendGate = undefined
      const binding = listBindings(result.accountId).find((binding) => binding.chat === 'visitor')!
      expect(host.getChatInfo(binding.chatId, 20).messages.find((message) => message.meta.context)?.meta.context).toBe(
        'Private platform context',
      )
      await host.waitIdle(binding.chatId, 5000)
      await settle(() => sends.length >= before + 4)
      expect(
        sends
          .slice(before)
          .map((message) => message.text)
          .join(''),
      ).toBe('abcdefghijklmnop')
      expect(sends.slice(before).every((message) => Array.from(message.text).length <= 5)).toBe(true)
      const info = host.getChatInfo(binding.chatId, 20)
      expect(info.messages.find((message) => message.meta.context)?.meta.context).toBe('Private platform context')
      expect(
        model.requests.some((request) =>
          request.messages.some((message) => message.content.includes(definition.promptHint!)),
        ),
      ).toBe(true)
      expect(
        model.requests.some((request) =>
          request.messages.some((message) => message.content.includes('Private platform context')),
        ),
      ).toBe(true)
      expect(api.lookup(binding.chatId)?.actors).toEqual([
        { externalId: 'visitor', name: 'Visitor', role: 'owner', paired: true },
      ])
      expect(api.lookupAll(binding.chatId)).toHaveLength(1)
      expect(api.lookup('missing')).toBeNull()
      runAsUser(other, () => {
        expect(api.lookupAll(binding.chatId)).toEqual([])
        io.saveCursor({ fromOtherContext: true })
      })
      expect(accountRow(result.accountId).providerState.cursor).toEqual({ fromOtherContext: true })
      await emit('inbound', 'duplicate')
      expect(host.getChatInfo(binding.chatId, 20).messages).toHaveLength(info.messages.length)
      const sent = sends.length
      await emit('group', 'ignored', { chat: { id: 'group', title: 'Group', scope: 'group' as const } })
      expect(sends.length).toBe(sent)
      // 校验发生在绑定和生成前，非法图片不妨碍文本去重和排队。
      const invalid = { bytes: new Uint8Array(1), mime: 'text/plain' }
      await emit('inbound', '', {
        images: [invalid, { bytes: new Uint8Array(5 * 1024 * 1024 + 1), mime: 'image/png' }, invalid, invalid, invalid],
      })
      expect(
        getSetting<{ code: string }[]>('channels:log')?.filter((entry) => entry.code === 'inbound.image.rejected'),
      ).toHaveLength(5)
      const queuedBefore = host
        .getChatInfo(binding.chatId, 100)
        .messages.filter((message) => message.role === 'user').length
      model.setScript(() => ({ text: 'queue reply', delayMs: 30 }))
      await emit('busy', 'start busy')
      await emit('late', 'late', { sentAt: 300 })
      await emit('early', 'early', { sentAt: 100 })
      await emit('equal', 'equal', { sentAt: 100 })
      expect(getSetting<unknown[]>(`channels:pending:${binding.id}`)?.length).toBe(3)
      await settle(
        () =>
          host.getChatInfo(binding.chatId, 100).messages.filter((message) => message.role === 'user').length >=
          queuedBefore + 2,
      )
      await host.waitIdle(binding.chatId, 5000)
      expect(
        host
          .getChatInfo(binding.chatId, 100)
          .messages.filter((message) => message.role === 'user')
          .at(-1)?.content,
      ).toBe('early\nequal\nlate')
      await client.call('sendMessage', { chat_id: 'visitor', text: 'drain' })
      model.setScript(() => ({ text: 'image reply', delayMs: 1 }))
      await emit('valid-image', 'look', { images: [{ bytes: png, mime: 'image/png' }] })
      await host.waitIdle(binding.chatId, 5000)
      expect(
        host
          .getChatInfo(binding.chatId, 100)
          .messages.filter((message) => message.role === 'user')
          .at(-1)?.meta.images,
      ).toHaveLength(1)
      await client.call('sendMessage', { chat_id: 'visitor', text: 'drain' })
      const delays: number[] = []
      let clock = 100000
      const rateClient = new PluginChannelClient(
        { ...definition, limits: { maxTextLength: 5, minIntervalMs: 5000, perMinute: 1 } },
        { id: 'rate', config: {}, cursor: null },
        accountRow(result.accountId).config,
        new AbortController().signal,
      )
      rateClient.status('online')
      rateClient.now = () => clock
      rateClient.sleep = async (ms) => {
        delays.push(ms)
        clock += ms
      }
      await rateClient.call('sendMessage', { chat_id: 'visitor', text: '123456' })
      expect(delays).toEqual([0, 60000])
      io.saveCursor({ page: 2 })
      expect(accountRow(result.accountId).providerState.cursor).toEqual({ page: 2 })
      io.status('paused', 'Captcha')
      const statusLogs = () =>
        getSetting<{ code: string }[]>('channels:log')!.filter((entry) => entry.code === 'status.paused').length
      const pauseLogs = statusLogs()
      let statusCalls = 0
      const originalStatus = client.status.bind(client)
      client.status = (status) => {
        statusCalls++
        originalStatus(status)
      }
      io.status('paused', 'Captcha')
      expect(statusCalls).toBe(1)
      expect(statusLogs()).toBe(pauseLogs)
      io.status('paused', 'Captcha changed')
      expect(statusLogs()).toBe(pauseLogs + 1)
      io.status('paused', 'Captcha')
      expect(accountDTO(accountRow(result.accountId)).lastError).toBe('Captcha')
      behavior = 'not-sent'
      failures = 0
      const paused = client.call('sendMessage', { chat_id: 'visitor', text: 'retry' })
      await Bun.sleep(20)
      expect(failures).toBe(0)
      io.status('online')
      await paused
      expect(failures).toBe(3)
      failures = 0
      pauseOnFailure = true
      const retryPaused = client.call('sendMessage', { chat_id: 'visitor', text: 'again' })
      await Bun.sleep(20)
      expect(failures).toBe(1)
      await Bun.sleep(20)
      expect(failures).toBe(1)
      io.status('online')
      pauseOnFailure = false
      await retryPaused
      expect(failures).toBe(3)
      behavior = 'captcha'
      failures = 0
      const captcha = client.call('sendMessage', { chat_id: 'visitor', text: 'solve' })
      for (let n = 1; n <= 5; n++) {
        await settle(() => failures === n)
        await Bun.sleep(20)
        expect(failures).toBe(n)
        io.status('online')
      }
      await captcha
      expect(failures).toBe(6)
      behavior = 'no-delay'
      failures = 0
      await expect(client.call('sendMessage', { chat_id: 'visitor', text: 'fail' })).rejects.toHaveProperty(
        'kind',
        'not-sent',
      )
      expect(failures).toBe(1)
      failures = 0
      behavior = 'never-sent'
      await expect(client.call('sendMessage', { chat_id: 'visitor', text: 'limit' })).rejects.toHaveProperty(
        'kind',
        'not-sent',
      )
      expect(failures).toBe(4)
      failures = 0
      behavior = 'error'
      await expect(client.call('sendMessage', { chat_id: 'visitor', text: 'error' })).rejects.toHaveProperty(
        'message',
        'private detail',
      )
      expect(failures).toBe(1)
      behavior = 'unknown'
      failures = 0
      await expect(client.call('sendMessage', { chat_id: 'visitor', text: 'oops' })).rejects.toHaveProperty(
        'kind',
        'unknown',
      )
      expect(failures).toBe(1)
      failures = 0
      await emit('unknown-command', '/help')
      await emit('unknown-command', '/help')
      await settle(() => failures === 1)
      expect(failures).toBe(1)
      expect(
        getSetting<{ code: string; message: string }[]>('channels:log')?.some(
          (entry) => entry.code === 'delivery.uncertain' && entry.message.includes('unknown private detail'),
        ),
      ).toBe(true)
      behavior = 'ok'
      const unsupportedBefore = sends.length
      for (const method of [
        'editMessageText',
        'deleteMessage',
        'sendPhoto',
        'sendVoice',
        'sendSticker',
        'setMessageReaction',
        'pinChatMessage',
        'sendMessageDraft',
      ])
        await client.call(method, { chat_id: 'visitor', text: 'ignored' })
      expect(sends.length).toBe(unsupportedBefore)
      expect(await client.call('getMe')).toMatchObject({ id: result.accountId, is_bot: true })
      io.setOwner(null)
      const mirrored = host.appendMessage(binding.chatId, { role: 'assistant', content: 'web mirror' })
      await service.deliver(binding, mirrored)
      expect(
        getSetting<{ code: string }[]>('channels:log')?.some((entry) => entry.code === 'delivery.skipped.no-initiate'),
      ).toBe(true)
      await service.generate(binding, {
        mode: 'regenerate',
        targetId: info.messages.find((message) => message.role === 'assistant')!.id,
      })
      await host.waitIdle(binding.chatId, 5000)
      const last = host.getChatInfo(binding.chatId).messages.at(-1)!
      const count = sends.length
      await service.deliver(binding, last)
      expect(sends.length).toBe(count)
      // 未知结果留下投递记录，不因再次收到同一消息而重发。
      io.setOwner('visitor')
      behavior = 'unknown'
      failures = 0
      const uncertain = host.appendMessage(binding.chatId, { role: 'assistant', content: 'uncertain' })
      await service.deliver(binding, uncertain)
      expect(
        db.select().from(channelDeliveries).where(eq(channelDeliveries.messageId, uncertain.id)).get()?.status,
      ).toBe('uncertain')
      await service.deliver(binding, loadMessage(uncertain.id))
      expect(failures).toBe(1)
      expect(
        getSetting<{ code: string; message: string }[]>('channels:log')?.some(
          (entry) => entry.code === 'delivery.uncertain' && entry.message === 'unknown private detail',
        ),
      ).toBe(true)
      behavior = 'never-sent'
      const failed = host.appendMessage(binding.chatId, { role: 'assistant', content: 'failed' })
      await service.deliver(binding, failed)
      expect(
        getSetting<{ code: string; message: string }[]>('channels:log')?.some(
          (entry) => entry.code === 'delivery.failed' && entry.message === 'not-sent BUDGET BUDGET',
        ),
      ).toBe(true)
      behavior = 'error'
      const generic = host.appendMessage(binding.chatId, { role: 'assistant', content: 'generic' })
      await service.deliver(binding, generic)
      expect(
        getSetting<{ code: string; message: string }[]>('channels:log')?.some(
          (entry) => entry.code === 'delivery.uncertain' && entry.message === 'Error private detail',
        ),
      ).toBe(true)
      const oldIO = io
      registration.unregister()
      registration.unregister()
      expect(accountDTO(accountRow(result.accountId)).lastError).toBe('PROVIDER_UNAVAILABLE')
      await expect(service.runtime.start(result.accountId)).rejects.toHaveProperty('code', 'PROVIDER_UNAVAILABLE')
      expect(() => oldIO.status('online')).toThrow('Channel provider stopped')
      expect(() => oldIO.saveCursor(3)).toThrow('Channel provider stopped')
      expect(() => oldIO.setOwner(null)).toThrow('Channel provider stopped')
      expect(() =>
        oldIO.emit({
          id: 'late',
          text: '',
          chat: { id: 'visitor', title: '' },
          from: { id: 'visitor', name: '' },
          sentAt: 0,
        }),
      ).toThrow('Channel provider stopped')
      const restart = new AbortController()
      // 启动任务仍在微任务队列时注销并恢复，不能复用被取消的旧任务。
      const restartingAPI = extensionChannels('test-plugin', host, true, restart.signal)
      const transient = restartingAPI.registerProvider(definition)
      transient.unregister()
      readyOnStart = false
      const restored = restartingAPI.registerProvider(definition)
      transient.unregister()
      await settle(() => service.runtime.accounts.has(result.accountId))
      expect(accountDTO(accountRow(result.accountId)).providerAvailable).toBe(true)
      expect(accountRow(result.accountId).status).toBe('connecting')
      const restoredClient = service.runtime.accounts.get(result.accountId)!.client
      behavior = 'ok'
      failures = 0
      const initialSend = restoredClient.call('sendMessage', { chat_id: 'visitor', text: 'ready' })
      await Bun.sleep(20)
      expect(failures).toBe(0)
      signal.abort()
      registration.unregister()
      expect(accountDTO(accountRow(result.accountId)).providerAvailable).toBe(true)
      io.status('online')
      await initialSend
      expect(failures).toBe(1)
      restored.unregister()
      restored.unregister()
      expect(listBindings(result.accountId)).toHaveLength(2)
      restart.abort()
      expect(db.select().from(channelAccounts).all()).toHaveLength(2)
    })
  } finally {
    releaseSend?.()
    signal.abort()
    run(() => service?.dispose())
    model.stop()
    closeUserDatabase(owner.handle)
    await rm(directory, { recursive: true, force: true })
  }
}, 50000)
