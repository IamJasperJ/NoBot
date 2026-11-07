import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChannelInboundMessage, ChannelProviderDefinition, ChannelProviderIO } from '../src/extensions/sdk'

test('渠道平台群聊与主人私信直接绑定：新位置批准、房间、成员、@ / 引用触发、主动发言限制、bind', async () => {
  // 渠道服务带全局状态，放进子进程跑，避免和其他测试互相影响
  if (!process.env.CHANNEL_PROVIDER_GROUP_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, CHANNEL_PROVIDER_GROUP_CHILD: '1', MOCK_LLM_FETCH: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'nobot-provider-group-'))
  process.env.DATA_DIR = directory
  delete (globalThis as typeof globalThis & { __NOBOT_TEST_USER__?: string }).__NOBOT_TEST_USER__
  const { eq } = await import('drizzle-orm')
  const { systemDatabase } = await import('../src/db/system-client')
  const { users } = await import('../src/db/system-schema')
  const { runAsUser, closeUserDatabase } = await import('../src/user-context')
  const { db } = await import('../src/db/client')
  const { channelBindings, channelRequests } = await import('../src/db/schema')
  const { createExtensionHost } = await import('../src/extensions/host')
  const registry = await import('../src/extensions/registry')
  const { channelService } = await import('../src/extensions/builtin/channels')
  const { extensionChannels } = await import('../src/extensions/builtin/channels/provider-host')
  const { accountRow, bindingRow, listBindings } = await import('../src/extensions/builtin/channels/store')
  const { respondRequest } = await import('../src/extensions/builtin/channels/policies')
  const { createCharacter } = await import('../src/services/characters')
  const { createApiPreset } = await import('../src/services/connections')
  const { apiPresetInput } = await import('@nobot/shared')
  const { mockLlm } = await import('./helpers/mockLlm')
  const { PluginChannelClient } = await import('../src/extensions/builtin/channels/adapters/plugin')
  const owner = { id: 'group-owner', handle: 'group-owner', name: 'Owner', isAdmin: true }
  systemDatabase()
    .insert(users)
    .values({ ...owner, passwordHash: 'unused', createdAt: Date.now() })
    .run()
  const run = <T>(fn: () => T) => runAsUser(owner, fn)
  const host = createExtensionHost(registry.emitServerEvent)
  const model = mockLlm()
  let io!: ChannelProviderIO
  const sends: { chatId: string; text: string }[] = []
  const definition: ChannelProviderDefinition = {
    id: 'dy',
    name: 'Test Group',
    scopes: ['private', 'group'],
    canInitiate: false,
    limits: { maxTextLength: 2000, minIntervalMs: 0, perMinute: 120 },
    media: { inboundImages: false, outboundImages: false, voice: false },
    accountFields: [],
    defaults: { newLocation: { private: 'approve', group: 'approve' }, trigger: { group: 'mention' } },
    start(_account, value) {
      io = value
      io.status('online')
    },
    async send(_account, message) {
      sends.push(message)
      return { id: `sent-${sends.length}` }
    },
  }
  const signal = new AbortController()
  let service!: ReturnType<typeof channelService>
  const api = run(() => extensionChannels('group-plugin', host, true, signal.signal, 'Group Plugin'))
  let seq = 0
  const emit = (from: string, text: string, extra: Partial<ChannelInboundMessage> = {}) =>
    io.emit({
      id: `m${++seq}`,
      text,
      from: { id: from, name: from.toUpperCase() },
      chat: { id: 'g1', title: 'Group One', scope: 'group' },
      sentAt: Date.now(),
      ...extra,
    })
  const settle = async (condition: () => boolean) => {
    for (let n = 0; n < 1000 && !condition(); n++) await Bun.sleep(10)
    expect(condition()).toBe(true)
  }
  /** 等过房间「每条都接」的 1 秒合并窗口，确认没有新的发送（用于「不应触发」的断言） */
  const quiet = async (before: number) => {
    await Bun.sleep(1800)
    expect(sends.length).toBe(before)
  }
  try {
    await run(async () => {
      service = channelService({ host })
      registry.updateExtension('channels', { enabled: true })
      api.registerProvider(definition)
      const character = createCharacter({ name: 'Alice', firstMes: 'GREETING' })
      const { accountId } = await api.ensureAccount('dy', { name: 'DY', characterId: character.id })
      await service.runtime.start(accountId)
      expect(accountRow(accountId).config.policies.newLocation.group).toBe('approve')
      createApiPreset(apiPresetInput.parse({ name: 'Mock', baseUrl: model.url, model: 'mock-one' }))
      model.setScript(() => ({ text: 'group reply', delayMs: 1 }))
      const client = service.runtime.accounts.get(accountId)!.client as InstanceType<typeof PluginChannelClient>
      client.sleep = async () => {}

      // 群的新位置按 defaults.newLocation.group 走批准
      await emit('a', '@Alice hello group', { mentionsMe: true })
      const request = db.select().from(channelRequests).where(eq(channelRequests.chat, 'g1')).get()!
      expect(request).toMatchObject({ kind: 'new-location', state: 'pending' })
      expect(sends).toHaveLength(0)
      await respondRequest(request.id, 'approve', client)
      const binding = listBindings(accountId).find((item) => item.chat === 'g1')!
      // 新群绑定用平台声明的默认触发方式
      expect(binding).toMatchObject({ scope: 'group', trigger: 'mention' })
      expect(binding.roomId).toBeTruthy()
      await host.waitIdle(binding.chatId, 5000)
      await settle(() => sends.some((message) => message.chatId === 'g1'))
      // send 的 chatId 是群的外部 id
      expect(sends.every((message) => message.chatId === 'g1')).toBe(true)

      // 房间默认「智能接话」要等安静 4 秒，后面改成「每条都接」（1 秒）缩短测试
      const rooms = await import('../src/services/rooms')
      rooms.updateRoom(binding.roomId!, { turnMode: 'every' })
      // 每个发言人一个平台用户档案；lookup 返回群范围和成员
      const afterApproval = sends.length
      db.update(channelBindings).set({ trigger: 'follow-room' }).where(eq(channelBindings.id, binding.id)).run()
      await emit('b', 'hi from b')
      // follow-room：群里任何人发言都按房间规则接话
      await settle(() => sends.length > afterApproval)
      await host.waitIdle(binding.chatId, 5000)
      const lookup = api.lookup(binding.chatId)!
      expect(lookup.scope).toBe('group')
      expect(lookup.external.chat).toBe('g1')
      expect(lookup.actors.map((actor) => actor.externalId).sort()).toEqual(['a', 'b'])

      // 触发方式「被 @」：只有 mentionsMe 的消息触发
      db.update(channelBindings).set({ trigger: 'mention' }).where(eq(channelBindings.id, binding.id)).run()
      let before = sends.length
      await emit('a', 'no mention')
      await host.waitIdle(binding.chatId, 5000)
      await quiet(before)
      await emit('a', '@Alice hi', { mentionsMe: true })
      await settle(() => sends.length > before)
      await host.waitIdle(binding.chatId, 5000)

      // 触发方式「回复我」：插件给出 repliesToMe 时以插件为准；没给时按投递记录判断
      db.update(channelBindings).set({ trigger: 'reply' }).where(eq(channelBindings.id, binding.id)).run()
      const mine = `sent-${sends.length}`
      before = sends.length
      await emit('b', 'plain message')
      await host.waitIdle(binding.chatId, 5000)
      await quiet(before)
      await emit('b', 'quoting someone else', { replyTo: 'not-mine' })
      await host.waitIdle(binding.chatId, 5000)
      await quiet(before)
      await emit('b', 'plugin says not me', { replyTo: mine, repliesToMe: false })
      await host.waitIdle(binding.chatId, 5000)
      await quiet(before)
      await emit('b', 'quote my message', { replyTo: mine })
      await settle(() => sends.length > before)
      await host.waitIdle(binding.chatId, 5000)
      before = sends.length
      await emit('b', 'plugin says me', { repliesToMe: true })
      await settle(() => sends.length > before)
      await host.waitIdle(binding.chatId, 5000)

      // 主人在群里也不能主动发：网页发言触发的回复不投递
      io.setOwner('a')
      await emit('a', 'owner speaks', { mentionsMe: false })
      await host.waitIdle(binding.chatId, 5000)
      expect(api.lookup(binding.chatId)?.ownerPresent).toBe(true)
      before = sends.length
      const { sendRoomMessage } = await import('../src/services/rooms/turns')
      sendRoomMessage(binding.roomId!, { text: 'from the web', channel: 'ic', clientMessageId: 'web-1' })
      // 等这轮回复真的生成出来（父消息是网页发言），再确认它没有发到群里
      const answeredWeb = () => {
        const list = host.getChatInfo(binding.chatId, 200).messages
        const web = list.find((message) => message.content === 'from the web')
        return !!web && list.some((message) => message.role === 'assistant' && message.parentId === web.id)
      }
      await settle(answeredWeb)
      await host.waitIdle(binding.chatId, 5000)
      await quiet(before)
      expect(bindingRow(binding.id).state).toBe('active')

      // bind：把主人私信直接绑到已有的家里会话，跳过新位置批准
      const { createChat } = await import('../src/services/chats')
      const home = createChat({ characterId: character.id })
      io.setOwner('owner-sec')
      const dm = { id: 'owner-sec', title: 'Owner DM' }
      const { bindingId } = api.bind('dy', { chat: dm, chatId: home.id })
      // 幂等，完整 id 也可以
      expect(api.bind('group-plugin.dy', { chat: dm, chatId: home.id }).bindingId).toBe(bindingId)
      expect(bindingRow(bindingId)).toMatchObject({
        scope: 'private',
        chat: 'owner-sec',
        chatId: home.id,
        state: 'active',
      })
      expect(db.select().from(channelRequests).where(eq(channelRequests.chat, 'owner-sec')).get()).toBeUndefined()
      expect(() => api.bind('dy', { chat: dm, chatId: 'missing-chat' })).toThrow()
      expect(() => api.bind('dy', { chat: { ...dm, scope: 'group' }, chatId: home.id })).toThrow()
      expect(() => api.bind('other', { chat: dm, chatId: home.id })).toThrow()
      // 主人私信享有不能主动发起的豁免：网页触发的回复（主人还没从抖音发过言）也能发出
      before = sends.length
      host.trigger(home.id)
      await host.waitIdle(home.id, 5000)
      await settle(() => sends.slice(before).some((message) => message.chatId === 'owner-sec'))
      // 主人从抖音发来的消息写进家里会话，回复回到抖音私信
      before = sends.length
      await io.emit({
        id: 'dm-1',
        text: 'hi from douyin',
        from: { id: 'owner-sec', name: 'Owner' },
        chat: dm,
        sentAt: Date.now(),
      })
      await host.waitIdle(home.id, 5000)
      await settle(() => sends.slice(before).some((message) => message.chatId === 'owner-sec'))
      expect(host.getChatInfo(home.id, 50).messages.some((message) => message.content === 'hi from douyin')).toBe(true)
      // 已绑在别的会话就改绑过来，绑定 id 不变
      const other = createChat({ characterId: character.id })
      expect(api.bind('dy', { chat: dm, chatId: other.id }).bindingId).toBe(bindingId)
      expect(bindingRow(bindingId).chatId).toBe(other.id)
    })
  } finally {
    signal.abort()
    run(() => service?.dispose())
    model.stop()
    closeUserDatabase(owner.handle)
    await rm(directory, { recursive: true, force: true })
  }
}, 50000)
