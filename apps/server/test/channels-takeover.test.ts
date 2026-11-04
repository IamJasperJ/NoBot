import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('渠道接手：库内会话、无绑定、进入方式、房间身份及数字菜单', async () => {
  if (!process.env.TAKEOVER_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, TAKEOVER_TEST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => child.kill(), 60000)
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, out + err).toBe(0)
    } finally {
      clearTimeout(timer)
    }
    return
  }
  delete (globalThis as typeof globalThis & { __NOBOT_TEST_USER__?: string }).__NOBOT_TEST_USER__
  const directory = await mkdtemp(join(tmpdir(), 'nobot-takeover-'))
  process.env.DATA_DIR = directory
  const { channelAccountInput, createRoomInput } = await import('@nobot/shared')
  const { eq } = await import('drizzle-orm')
  const { db, newId } = await import('../src/db/client')
  const { channelActors, channelActions, chats, messages, promptPresets, backgrounds } = await import(
    '../src/db/schema'
  )
  const { systemDatabase } = await import('../src/db/system-client')
  const { users, roomMembers } = await import('../src/db/system-schema')
  const { runAsUser, closeUserDatabase } = await import('../src/user-context')
  const { createExtensionHost } = await import('../src/extensions/host')
  const registry = await import('../src/extensions/registry')
  const { channelService } = await import('../src/extensions/builtin/channels')
  const { listBindings } = await import('../src/extensions/builtin/channels/store')
  const { actorPersonaId } = await import('../src/extensions/builtin/channels/personas')
  const { createCharacter } = await import('../src/services/characters')
  const { createChat, getChatRow, updateChat } = await import('../src/services/chats')
  const { createPersona } = await import('../src/services/personas')
  const { createRoom } = await import('../src/services/rooms')
  const { OneBotClient } = await import('../src/extensions/builtin/channels/adapters/onebot11/client')
  const { OneBotSendQueue } = await import('../src/extensions/builtin/channels/adapters/onebot11/transport')
  const owner = { id: 'takeover-owner', handle: 'takeover-owner', name: 'Owner', isAdmin: true }
  const player = { id: 'takeover-player', handle: 'takeover-player', name: 'Player', isAdmin: false }
  for (const user of [owner, player])
    systemDatabase()
      .insert(users)
      .values({ ...user, passwordHash: 'unused', createdAt: Date.now() })
      .run()
  const host = createExtensionHost(registry.emitServerEvent)
  let service!: ReturnType<typeof channelService>
  try {
    await runAsUser(owner, async () => {
      registry.updateExtension('channels', { enabled: true })
      service = channelService({
        host,
        settings: {},
        storage: { get: () => undefined, set: () => {}, delete: () => {} },
      })
      const calls: Record<string, unknown>[] = []
      service.runtime.fetch = async (input, init) => {
        const method = String(input).split('/').at(-1)
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        if (method === 'sendMessage') calls.push(body)
        return Response.json({
          ok: true,
          result:
            method === 'getMe'
              ? { id: 999, is_bot: true, username: 'test_bot', first_name: 'Test' }
              : method === 'sendMessage'
                ? { message_id: calls.length }
                : true,
        })
      }
      const character = createCharacter({ name: 'Alice' })
      const account = await service.runtime.create(
        channelAccountInput.parse({
          name: 'Telegram',
          credentials: { token: 'test', webhookSecret: 'test' },
          receiveMode: 'webhook',
          webhookUrl: 'https://example.test/hook',
          defaultCharacterId: character.id,
          settings: { actorRateLimit: 1000 },
        }),
      )
      await service.runtime.start(account.id)
      const actor = db
        .insert(channelActors)
        .values({
          id: newId(),
          provider: 'telegram',
          externalId: '111',
          displayName: 'Owner',
          role: 'owner',
          linkedUserId: owner.id,
          dmChatId: '111',
        })
        .returning()
        .get()!
      const persona = createPersona({ name: 'Original', description: 'Original persona' })
      const channelPersona = actorPersonaId({ accountId: account.id, personaMode: null }, actor)!
      const same = createChat({ characterId: character.id })
      updateChat(same.id, { title: 'Same persona', personaId: channelPersona })
      const target = createChat({ characterId: character.id })
      updateChat(target.id, { title: 'Web chat', personaId: persona.id })
      const preset = db
        .insert(promptPresets)
        .values({ id: newId(), name: 'Keep preset', createdAt: Date.now(), updatedAt: Date.now() })
        .returning()
        .get()!
      const background = db
        .insert(backgrounds)
        .values({
          id: newId(),
          name: 'Keep background',
          width: 100,
          height: 100,
          source: 'upload',
          createdAt: Date.now(),
        })
        .returning()
        .get()!
      db.update(chats)
        .set({ promptPresetId: preset.id, backgroundId: background.id, authorNote: 'Keep note', vars: { keep: true } })
        .where(eq(chats.id, target.id))
        .run()
      let sequence = 1
      const message = async (text: string, from = 111, chat = from) =>
        service.receive(account.id, {
          update_id: sequence++,
          message: {
            message_id: sequence,
            chat: { id: chat, type: 'private' },
            from: { id: from, first_name: 'Owner' },
            text,
          },
        })
      const actions = () =>
        db
          .select()
          .from(channelActions)
          .all()
          .filter((action) => !action.usedAt && action.expiresAt > Date.now())
      const click = async (predicate: (action: ReturnType<typeof actions>[number]) => boolean, from = 111) => {
        const action = actions().find(predicate)
        expect(action).toBeDefined()
        await service.receive(account.id, {
          update_id: sequence++,
          callback_query: {
            id: String(sequence),
            from: { id: from },
            data: action!.token,
            message: { message_id: 1, chat: { id: 111, type: 'private' } },
          },
        })
      }
      const choose = async (id: string) => {
        await message('/chats')
        await click((action) => action.action === 'chat' && action.args.chatId === id)
      }
      const binding = () => listBindings(account.id).find((item) => item.chat === '111')!
      const count = db.select().from(chats).all().length
      await choose(same.id)
      expect(binding().source).toBe('attached')
      expect(binding().chatId).toBe(same.id)
      expect(db.select().from(chats).all()).toHaveLength(count)
      expect(actions().some((action) => action.action === 'chat-enter')).toBe(false)
      await choose(target.id)
      expect(calls.at(-1)?.text).toBe('你还没有在这个会话里出现过，选择进入方式')
      await click((action) => action.action === 'chat-enter' && action.args.userId === null)
      expect(binding().takeover).toEqual({ chatId: target.id, userId: null })
      await message('((Keep persona')
      expect(getChatRow(target.id)).toMatchObject({
        personaId: persona.id,
        promptPresetId: preset.id,
        backgroundId: background.id,
        authorNote: 'Keep note',
        vars: { keep: true },
      })
      await choose(same.id)
      expect(binding().takeover).toBeNull()
      await choose(target.id)
      await click((action) => action.action === 'chat-enter' && !('userId' in action.args))
      expect(getChatRow(target.id).personaId).toBe(persona.id)
      await message('((Use channel persona')
      expect(getChatRow(target.id).personaId).toBe(channelPersona)
      expect(getChatRow(target.id)).toMatchObject({ promptPresetId: preset.id, backgroundId: background.id })
      await choose(same.id)
      updateChat(target.id, { personaId: persona.id })
      await choose(target.id)
      await click((action) => action.action === 'chat-enter' && action.args.userId === null)
      await message(`/persona ${channelPersona}`)
      expect(binding().takeover).toBeNull()

      const roomChat = createChat({ characterId: character.id })
      const room = createRoom(createRoomInput.parse({ name: 'Room', chatId: roomChat.id }))
      systemDatabase()
        .insert(roomMembers)
        .values({
          roomId: room.id,
          userId: player.id,
          role: 'player',
          personaName: 'Player persona',
          personaDescription: '',
          acceptedRulesVersion: 1,
          joinedAt: Date.now(),
        })
        .run()
      host.appendMessage(roomChat.id, { role: 'user', content: 'Earlier', meta: { author: { userId: player.id } } })
      await choose(roomChat.id)
      expect(calls.at(-1)?.text).toBe('你还没有在这个会话里出现过，选择进入方式')
      await click((action) => action.action === 'chat-enter' && action.args.userId === player.id)
      await message('((Take over player')
      expect(
        db
          .select()
          .from(messages)
          .where(eq(messages.chatId, roomChat.id))
          .all()
          .find((item) => item.content.includes('Take over player'))?.meta.author?.userId,
      ).toBe(player.id)
      await choose(same.id)
      expect(binding().takeover).toBeNull()
      await message('/chats')
      await click((action) => action.action === 'chat-list' && action.args.newChat === true)
      expect(actions().some((action) => action.action === 'picker')).toBe(true)
      const beforeNew = db.select().from(chats).all().length
      await click((action) => action.action === 'picker' && action.args.targetId === character.id)
      expect(db.select().from(chats).all()).toHaveLength(beforeNew + 1)
      expect(binding().chatId).not.toBe(same.id)
      expect(binding().takeover).toBeNull()

      // 非主人仍只能列出当前绑定历史。
      db.insert(channelActors)
        .values({
          id: newId(),
          provider: 'telegram',
          externalId: '222',
          displayName: 'Player',
          role: 'player',
          linkedUserId: player.id,
        })
        .run()
      service.saveBinding({
        ...binding(),
        id: newId(),
        chat: '222',
        chatId: roomChat.id,
        roomId: room.id,
        takeover: null,
      })
      await message('/chats', 222)
      const last = calls.at(-1) as { reply_markup?: { inline_keyboard: { text: string }[][] } }
      expect(last.reply_markup?.inline_keyboard.flat().map((button) => button.text)).not.toContain('Web chat')

      // Telegram 每页八个会话，翻页仍使用动作令牌。
      for (let i = 0; i < 9; i++) createChat({ characterId: character.id })
      await message('/chats')
      expect(
        actions().filter((action) => action.action === 'chat' && action.args.accountId === account.id),
      ).toHaveLength(8)
      await click((action) => action.action === 'chat-list' && action.args.page === 1)
      expect(actions().some((action) => action.action === 'chat-list' && action.args.page === 0)).toBe(true)

      service.runtime.oneBotQueue = (config) =>
        new OneBotSendQueue(
          config.rateLimit,
          Date.now,
          async () => {},
          () => 0,
        )
      const qq = await service.runtime.create(
        channelAccountInput.parse({
          provider: 'onebot11',
          name: 'QQ',
          credentials: { accessToken: 'test' },
          connection: { mode: 'ws-reverse' },
          defaultCharacterId: character.id,
        }),
      )
      await service.runtime.start(qq.id)
      const client = service.runtime.accounts.get(qq.id)!.client
      if (!(client instanceof OneBotClient)) throw new Error('QQ client missing')
      client.transport.attach({
        close: () => {},
        send: (raw) => {
          const call = JSON.parse(raw) as { action: string; echo: string }
          queueMicrotask(() =>
            client.transport.receive({
              echo: call.echo,
              status: 'ok',
              retcode: 0,
              data:
                call.action === 'get_login_info'
                  ? { user_id: 999, nickname: 'QQ' }
                  : call.action === 'get_version_info'
                    ? { app_name: 'test', app_version: '1' }
                    : call.action.startsWith('get_')
                      ? []
                      : { message_id: sequence++ },
            }),
          )
        },
      })
      await Bun.sleep(0)
      db.insert(channelActors)
        .values({ ...actor, id: newId(), provider: 'onebot11', personaId: channelPersona })
        .run()
      const qqMessage = async (text: string) =>
        service.receive(qq.id, {
          post_type: 'message',
          self_id: 999,
          user_id: 111,
          message_id: sequence++,
          message_type: 'private',
          sender: { nickname: 'Owner' },
          message: [{ type: 'text', data: { text } }],
        })
      await qqMessage('/chats')
      const qqTarget = actions().find((action) => action.args.accountId === qq.id && action.action === 'chat')!
      await qqMessage(String(qqTarget.args.number))
      const qqEnter = actions().find((action) => action.args.accountId === qq.id && action.action === 'chat-enter')
      if (qqEnter) await qqMessage(String(qqEnter.args.number))
      expect(listBindings(qq.id)[0]?.chatId).toBe(qqTarget.args.chatId as string)
      expect(listBindings(qq.id)[0]?.source).toBe('attached')
    })
  } finally {
    if (service) runAsUser(owner, () => service.dispose())
    closeUserDatabase(owner.handle)
    closeUserDatabase(player.handle)
    await rm(directory, { recursive: true, force: true })
  }
}, 70000)
