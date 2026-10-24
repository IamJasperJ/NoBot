import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('CH3 集成：真实房间桥、请求审批、私密投递、资料与单次舞台会话，两用户隔离', async () => {
  if (!process.env.CH3_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, CH3_TEST_CHILD: '1', MOCK_LLM_FETCH: '1', ASR_FETCH_MOCK: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'nobot-ch3-'))
  process.env.DATA_DIR = directory
  const { channelAccountInput } = await import('@nobot/shared')
  const { eq } = await import('drizzle-orm')
  const { db, setSetting } = await import('../src/db/client')
  const { channelAccounts, channelActors, channelRequests, channelMiniAppTokens } = await import('../src/db/schema')
  const { systemDatabase } = await import('../src/db/system-client')
  const { users, roomMembers } = await import('../src/db/system-schema')
  const { runAsUser, closeUserDatabase } = await import('../src/user-context')
  const { createExtensionHost } = await import('../src/extensions/host')
  const registry = await import('../src/extensions/registry')
  const { channelService } = await import('../src/extensions/builtin/channels')
  const { accountRow, listBindings, accountDTO } = await import('../src/extensions/builtin/channels/store')
  const { OneBotClient } = await import('../src/extensions/builtin/channels/adapters/onebot11/client')
  const { OneBotSendQueue } = await import('../src/extensions/builtin/channels/adapters/onebot11/transport')
  const { decideOneBotRequest, expireOneBotRequests } = await import(
    '../src/extensions/builtin/channels/adapters/onebot11/social'
  )
  const { oneTimeStageUrl, exchangeMiniApp } = await import('../src/extensions/builtin/channels/miniapp')
  const { socialBudget, signBudget } = await import('../src/extensions/builtin/channels/adapters/onebot11/interactions')
  const { checkIdle, leaveGroup } = await import('../src/extensions/builtin/channels/policies')
  const { createCharacter } = await import('../src/services/characters')
  const { createChat } = await import('../src/services/chats')
  const { Hono } = await import('hono')
  const owner = { id: 'qq-owner', handle: 'qq-owner', name: 'QQ owner', isAdmin: true }
  const other = { id: 'qq-other', handle: 'qq-other', name: 'Other', isAdmin: false }
  for (const user of [owner, other])
    systemDatabase()
      .insert(users)
      .values({ ...user, passwordHash: 'unused', createdAt: Date.now() })
      .run()
  const calls: { action: string; params: Record<string, unknown> }[] = []
  const host = createExtensionHost(registry.emitServerEvent)
  let service!: ReturnType<typeof channelService>
  let seq = 100
  let forwardFailure = false
  let playerFriend = false
  try {
    await runAsUser(owner, async () => {
      registry.updateExtension('channels', { enabled: true })
      service = channelService({
        host,
        settings: {},
        storage: { get: () => undefined, set: () => {}, delete: () => {} },
      })
      service.runtime.oneBotQueue = (config) =>
        new OneBotSendQueue(
          config.rateLimit,
          Date.now,
          async () => {},
          () => 0,
        )
      const { createApiPreset } = await import('../src/services/connections')
      const { apiPresetInput } = await import('@nobot/shared')
      const { mockLlm } = await import('./helpers/mockLlm')
      const model = mockLlm()
      createApiPreset(apiPresetInput.parse({ name: 'Mock', baseUrl: model.url, model: 'mock' }))
      const character = createCharacter({ name: 'Alice', description: 'Public\n\nPRIVATE' })
      const config = channelAccountInput.parse({
        provider: 'onebot11',
        name: 'QQ',
        connection: { mode: 'ws-reverse' },
        credentials: { accessToken: 'QQ_SECRET' },
        defaultCharacterId: character.id,
        presence: { name: { mode: 'custom', value: 'Alice' }, description: { mode: 'custom', value: 'x'.repeat(100) } },
      })
      const account = await service.runtime.create(config)
      expect(account.riskNotice).toBeTruthy()
      expect(JSON.stringify(account)).not.toContain('QQ_SECRET')
      await service.runtime.start(account.id)
      const client = service.runtime.accounts.get(account.id)!.client
      if (!(client instanceof OneBotClient)) throw new Error('client')
      client.transport.attach({
        close: () => {},
        send: (raw) => {
          const call = JSON.parse(raw) as { action: string; params: Record<string, unknown>; echo: string }
          calls.push(call)
          if (forwardFailure && call.action === 'send_group_forward_msg') {
            queueMicrotask(() =>
              client.transport.receive({ echo: call.echo, status: 'failed', retcode: 100, data: null }),
            )
            return
          }
          const data =
            call.action === 'get_login_info'
              ? { user_id: 999, nickname: 'QQ' }
              : call.action === 'get_version_info'
                ? { app_name: 'NapCat', app_version: 'test' }
                : call.action === 'get_friend_list'
                  ? [
                      { user_id: 111, nickname: 'Owner', remark: '' },
                      ...(playerFriend ? [{ user_id: 222, nickname: 'Player', remark: '' }] : []),
                    ]
                  : call.action === 'get_group_list'
                    ? []
                    : call.action === 'get_record'
                      ? { base64: 'SUQz' }
                      : call.action.startsWith('send_')
                        ? { message_id: ++seq }
                        : true
          queueMicrotask(() => client.transport.receive({ echo: call.echo, status: 'ok', retcode: 0, data }))
        },
      })
      await Bun.sleep(0)
      expect(accountRow(account.id).status).toBe('online')
      expect(accountDTO(accountRow(account.id)).implementation).toEqual({ name: 'NapCat', version: 'test' })
      const message = (text: string, id: number, group = false) => ({
        post_type: 'message',
        self_id: 999,
        user_id: 111,
        message_id: id,
        message_type: group ? 'group' : 'private',
        group_id: group ? 100 : undefined,
        sender: { nickname: 'Owner' },
        message: [{ type: 'text', data: { text } }],
      })
      await service.receive(account.id, message('/start', 1))
      expect(
        calls.some((call) => call.action === 'send_private_msg' && JSON.stringify(call.params).match(/\d{6}/)),
      ).toBe(true)
      const actor = db
        .insert(channelActors)
        .values({
          id: 'qq-actor',
          provider: 'onebot11',
          externalId: '111',
          displayName: 'Owner',
          role: 'owner',
          linkedUserId: owner.id,
          accountIds: [account.id],
          dmChatId: '111',
        })
        .returning()
        .get()
      const chat = createChat({ characterId: character.id })
      service.saveBinding({
        id: 'qq-binding',
        accountId: account.id,
        scope: 'private',
        chat: '111',
        title: 'QQ',
        thread: '',
        actor: '',
        isolation: 'dm',
        source: 'new',
        chatId: chat.id,
        roomId: null,
        state: 'active',
        speakers: {},
        trigger: 'all',
        personaMode: null,
        settings: {},
        createdBy: owner.id,
        lastActivityAt: Date.now(),
        idleWarnedAt: null,
      })
      const binding = listBindings(account.id)[0]!
      const assistant = host.appendMessage(chat.id, { role: 'assistant', content: 'Hello QQ' })
      await service.deliver(binding, assistant)
      const before = calls.length
      await service.deliver(binding, assistant)
      expect(calls.length).toBe(before)
      const request = {
        post_type: 'request',
        request_type: 'group',
        sub_type: 'invite',
        flag: 'invite-flag',
        group_id: 100,
        user_id: 111,
        time: 1,
      }
      await service.receive(account.id, request)
      const pending = db.select().from(channelRequests).where(eq(channelRequests.kind, 'group-invite')).get()!
      expect(pending.state).toBe('pending')
      await decideOneBotRequest(pending.id, true, client)
      expect(
        calls.some(
          (call) =>
            call.action === 'set_group_add_request' &&
            call.params.flag === 'invite-flag' &&
            call.params.sub_type === 'invite' &&
            call.params.approve === true,
        ),
      ).toBe(true)
      await service.receive(account.id, {
        post_type: 'request',
        request_type: 'friend',
        flag: 'friend-flag',
        user_id: 111,
        time: 2,
      })
      expect(calls.some((call) => call.action === 'set_friend_add_request' && call.params.approve === true)).toBe(true)
      await service.receive(account.id, { ...request, sub_type: 'add', flag: 'join-ignore', time: 3 })
      expect(calls.some((call) => call.params.flag === 'join-ignore')).toBe(false)
      db.update(channelAccounts)
        .set({ policies: { ...config.policies, joinRequests: 'notify' } })
        .where(eq(channelAccounts.id, account.id))
        .run()
      await service.receive(account.id, { ...request, sub_type: 'add', flag: 'join-notify', time: 4 })
      const joinRequest = db.select().from(channelRequests).where(eq(channelRequests.flag, 'join-notify')).get()!
      expect(joinRequest.state).toBe('pending')
      expect(calls.some((call) => call.params.flag === 'join-notify')).toBe(false)
      await decideOneBotRequest(joinRequest.id, false, client)
      expect(calls.at(-1)).toMatchObject({
        action: 'set_group_add_request',
        params: { sub_type: 'add', approve: false },
      })
      const expired = db
        .insert(channelRequests)
        .values({
          id: 'expired',
          accountId: account.id,
          kind: 'friend',
          chat: '222',
          title: '',
          flag: 'old',
          expiresAt: Date.now() - 1,
          createdAt: 0,
          state: 'pending',
        })
        .returning()
        .get()
      expireOneBotRequests()
      await expect(decideOneBotRequest(expired.id, true, client)).rejects.toThrow()
      expect(db.select().from(channelRequests).where(eq(channelRequests.id, expired.id)).get()!.state).toBe('expired')
      await service.runtime.presence(account.id).apply(true)
      expect(calls.some((call) => call.action === 'set_qq_profile' && call.params.nickname === 'Alice')).toBe(true)
      expect(
        calls.some(
          (call) =>
            call.action === 'set_self_longnick' &&
            String(call.params.longNick).length === 80 &&
            !('personal_note' in call.params),
        ),
      ).toBe(true)
      const rooms = await import('../src/services/rooms')
      const { createRoomInput } = await import('@nobot/shared')
      const trpg = await import('../src/services/rooms/trpg')
      const { parseStageMessage } = await import('@nobot/core/stage')
      const { addChannelMember } = await import('../src/extensions/builtin/channels/rooms')
      const groupChat = createChat({ characterId: character.id })
      const room = rooms.createRoom(
        createRoomInput.parse({ name: 'QQ group', chatId: groupChat.id, choiceMode: 'vote', turnMode: 'host' }),
      )
      service.saveBinding({
        ...binding,
        id: 'qq-group',
        scope: 'group',
        chat: '-100',
        chatId: groupChat.id,
        roomId: room.id,
        isolation: 'shared',
        trigger: 'follow-room',
      })
      const groupBinding = listBindings(account.id).find((value) => value.id === 'qq-group')!
      for (const id of ['222', '333']) {
        const player = db
          .insert(channelActors)
          .values({
            id: `player-${id}`,
            provider: 'onebot11',
            externalId: id,
            displayName: `Player ${id}`,
            role: 'player',
            accountIds: [account.id],
          })
          .returning()
          .get()
        const externalUserId = addChannelMember(room.id, player)
        db.update(channelActors).set({ externalUserId }).where(eq(channelActors.id, player.id)).run()
      }
      const content = 'Choose a path.\n<choices>\n- Left\n- Right\n</choices>'
      const rawChoice = host.appendMessage(groupChat.id, { role: 'assistant', content })
      const beforeRawChoice = calls.length
      await service.deliver(groupBinding, rawChoice)
      expect(JSON.stringify(calls.slice(beforeRawChoice))).not.toContain('1. Left')
      await service.receive(account.id, { ...message('/choose 1', 48, true), user_id: 222 })
      expect(host.getChatInfo(groupChat.id).chat.activeLeafId).toBe(rawChoice.id)
      await service.receive(account.id, { ...message('1', 49, true), user_id: 222 })
      expect(host.getChatInfo(groupChat.id).messages.at(-1)?.content).toBe('1')
      const choice = host.appendMessage(groupChat.id, {
        role: 'assistant',
        content,
        meta: { stage: parseStageMessage(content, { knownNames: [], vars: {}, inline: false, mvu: false }).stage },
      })
      trpg.registerChoices(rooms.roomRow(room.id), choice)
      await service.deliver(groupBinding, choice)
      expect(
        calls.some((call) => call.action === 'send_group_msg' && JSON.stringify(call.params).includes('1. Left')),
      ).toBe(true)
      await service.receive(account.id, { ...message('1', 50, true), user_id: 222 })
      expect(trpg.choiceSnapshot(room.id, choice.id).counts).toEqual([1, 0])
      await service.receive(account.id, { ...message('/choose 2', 51, true), user_id: 333 })
      expect(trpg.choiceSnapshot(room.id, choice.id).counts).toEqual([1, 1])
      const singleChoice = host.appendMessage(groupChat.id, {
        role: 'assistant',
        content,
        meta: choice.meta,
      })
      db.update(channelActors).set({ displayName: 'Unknown' }).where(eq(channelActors.id, 'player-222')).run()
      systemDatabase()
        .update(roomMembers)
        .set({ state: 'left' })
        .where(
          eq(
            roomMembers.userId,
            db.select().from(channelActors).where(eq(channelActors.id, 'player-333')).get()!.externalUserId!,
          ),
        )
        .run()
      await service.receive(account.id, {
        ...message('1', 53, true),
        user_id: 222,
        sender: { card: 'Player Card', nickname: 'Player' },
      })
      await host.waitIdle(groupChat.id, 5000)
      const picked = host
        .getChatInfo(groupChat.id)
        .messages.find((item) => item.meta.choice?.messageId === singleChoice.id)!
      expect(picked.meta.name).toBe('Player Card')
      expect(picked.meta.author?.name).toBe('Player Card')
      const external = db.select().from(channelActors).where(eq(channelActors.id, 'player-222')).get()!
      expect(systemDatabase().select().from(users).where(eq(users.id, external.externalUserId!)).get()!.name).toBe(
        'Player Card',
      )
      await service.deliver(groupBinding, picked)
      expect(
        calls.some(
          (call) => call.action === 'send_group_msg' && JSON.stringify(call.params).includes('Player Card: Left'),
        ),
      ).toBe(true)
      // 同一主人可能还绑定 Telegram；QQ 只能使用 QQ 身份投递，重放和多个群绑定也只能私发一次。
      db.insert(channelActors)
        .values({
          id: 'telegram-owner',
          provider: 'telegram',
          externalId: '111',
          displayName: 'Telegram Owner',
          role: 'owner',
          linkedUserId: owner.id,
          dmChatId: '111',
          accountIds: ['telegram-account'],
        })
        .run()
      const mirrorBinding = { ...groupBinding, id: 'qq-group-mirror', chat: '-101' }
      service.saveBinding(mirrorBinding)
      const beforeBlind = calls.length
      await service.receive(account.id, message('/roll 1d6 blind', 52, true))
      const blindMessage = host.getChatInfo(groupChat.id).messages.at(-1)!
      await Promise.all([service.deliver(groupBinding, blindMessage), service.deliver(mirrorBinding, blindMessage)])
      const blindCalls = calls.slice(beforeBlind)
      expect(blindCalls.filter((call) => call.action === 'send_private_msg')).toHaveLength(1)
      expect(blindCalls.every((call) => call.action !== 'send_group_msg')).toBe(true)
      service.saveBinding({ ...mirrorBinding, state: 'left' })
      const { asChannelActor } = await import('../src/extensions/builtin/channels/rooms')
      playerFriend = true
      client.invalidateFriends()
      const beforePlayerBlind = calls.length
      const playerBlind = asChannelActor(groupBinding, external, () =>
        trpg.rollRoom(room.id, { expression: '1d6', visibility: 'blind' }, () => 0),
      )
      expect(playerBlind.result).toBe('已掷骰，结果隐藏')
      await service.deliver(groupBinding, host.getChatInfo(groupChat.id).messages.at(-1)!)
      const playerBlindCalls = calls.slice(beforePlayerBlind).filter((call) => call.action === 'send_private_msg')
      expect(playerBlindCalls).toHaveLength(2)
      expect(playerBlindCalls.find((call) => call.params.user_id === 222)?.params.message).toEqual([
        { type: 'text', data: { text: '已掷骰，结果隐藏' } },
      ])
      expect(playerBlindCalls.find((call) => call.params.user_id === 111)?.params.message).toEqual([
        { type: 'text', data: { text: '1d6 = 1' } },
      ])
      playerFriend = false
      client.invalidateFriends()
      expect(calls.some((call) => call.action === 'set_group_card' && call.params.card === 'Alice')).toBe(true)
      await service.syncOneBotCard(groupBinding)
      const beforeCard = calls.filter((call) => call.action === 'set_group_card').length
      await service.syncOneBotCard(groupBinding)
      expect(calls.filter((call) => call.action === 'set_group_card').length).toBe(beforeCard)
      const multi = host.appendMessage(groupChat.id, { role: 'assistant', content: 'Alice：「Hello」\nBob：「Hi」' })
      service.saveBinding({ ...groupBinding, settings: { multiSpeaker: 'forward' } })
      const forwardBinding = listBindings(account.id).find((value) => value.id === 'qq-group')!
      await service.deliver(forwardBinding, multi)
      expect(calls.some((call) => call.action === 'send_group_forward_msg')).toBe(true)
      const fallback = host.appendMessage(groupChat.id, {
        role: 'assistant',
        content: 'Alice：「Again」\nBob：「Fallback」',
      })
      forwardFailure = true
      const beforeFallback = calls.length
      await service.deliver(forwardBinding, fallback)
      forwardFailure = false
      expect(
        calls
          .slice(beforeFallback)
          .some((call) => call.action === 'send_group_msg' && JSON.stringify(call.params).includes('Fallback')),
      ).toBe(true)
      const originalTranscribe = service.host.transcribe
      let transcribed = 0
      service.host.transcribe = async (bytes, mime) => {
        transcribed++
        expect(Buffer.from(bytes).toString()).toBe('ID3')
        expect(mime).toBe('audio/mpeg')
        return { kind: 'transcript', text: '((Voice decoded' }
      }
      const voice = {
        ...message('', 61, true),
        user_id: 222,
        message: [{ type: 'record', data: { file: 'test-voice' } }],
      }
      await service.receive(account.id, voice)
      await service.receive(account.id, voice)
      expect(transcribed).toBe(1)
      expect(host.getChatInfo(groupChat.id).messages.some((message) => message.content.includes('Voice decoded'))).toBe(
        true,
      )
      service.host.transcribe = originalTranscribe
      registry.updateExtension('audio', {
        enabled: true,
        settings: { asrEngine: 'openai-compatible', asrBaseUrl: 'http://unused-asr.invalid/v1', asrModel: 'whisper-1' },
      })
      const beforePrivateVoice = calls.length
      await service.receive(account.id, {
        ...message('', 63),
        message: [{ type: 'record', data: { file: 'private-voice' } }],
      })
      await host.waitIdle(chat.id, 5000)
      await Bun.sleep(150)
      expect(
        host
          .getChatInfo(chat.id)
          .messages.filter((item) => item.role === 'user')
          .at(-1)?.content,
      ).toBe('这是一条测试语音。')
      expect(host.getChatInfo(groupChat.id).messages.some((item) => item.content === '这是一条测试语音。')).toBe(false)
      expect(calls.slice(beforePrivateVoice).some((call) => call.action === 'get_record')).toBe(true)
      expect(calls.slice(beforePrivateVoice).some((call) => call.action === 'send_private_msg')).toBe(true)
      expect(calls.slice(beforePrivateVoice).some((call) => call.action === 'send_group_msg')).toBe(false)
      const privateReply = host.getChatInfo(chat.id).messages.at(-1)!
      const beforeWrongBinding = calls.length
      await service.deliver(groupBinding, privateReply)
      expect(calls.length).toBe(beforeWrongBinding)
      const beforeMissingDm = calls.length
      await service.receive(account.id, { ...message('/roll 1d6 self', 62, true), user_id: 222 })
      expect(
        calls
          .slice(beforeMissingDm)
          .filter((call) => call.action === 'send_group_msg')
          .every((call) => JSON.stringify(call.params).includes('请先私聊我一次')),
      ).toBe(true)
      const sharp = (await import('sharp')).default
      service.host.readAvatar = async () =>
        new Uint8Array(
          await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
            .png()
            .toBuffer(),
        )
      db.update(channelAccounts)
        .set({
          presence: {
            ...accountRow(account.id).config.presence,
            avatar: { mode: 'custom', value: character.id, languages: {} },
          },
        })
        .where(eq(channelAccounts.id, account.id))
        .run()
      await service.runtime.presence(account.id).sync(true)
      expect(
        calls.some((call) => call.action === 'set_qq_avatar' && String(call.params.file).startsWith('base64://')),
      ).toBe(true)
      setSetting('ext:channels', { publicBaseUrl: 'https://nobot.test' })
      const url = oneTimeStageUrl(binding, actor)!
      const token = new URL(url).searchParams.get('a')!
      const app = new Hono()
        .onError((error, c) => c.json({}, 'status' in error ? (Number(error.status) as 403) : 500))
        .post('/', (c) => c.json(exchangeMiniApp(c, { initData: '', start: token })))
      const first = await app.request('/', { method: 'POST' })
      expect(first.status).toBe(200)
      expect(first.headers.get('set-cookie')).toContain('HttpOnly')
      expect((await app.request('/', { method: 'POST' })).status).toBe(403)
      db.update(channelMiniAppTokens).set({ expiresAt: 0 }).where(eq(channelMiniAppTokens.token, token)).run()
      expect((await app.request('/', { method: 'POST' })).status).toBe(403)
      expect(
        socialBudget(account.id, 'poke:111', { ...service.settings(binding).values, socialDailyBudget: 1 }, 100000),
      ).toBe(true)
      expect(
        socialBudget(account.id, 'poke:222', { ...service.settings(binding).values, socialDailyBudget: 1 }, 100001),
      ).toBe(false)
      expect(signBudget(account.id, '100', 100000)).toBe(true)
      expect(signBudget(account.id, '100', 100001)).toBe(false)
      await leaveGroup(account.id, '-100', client)
      expect(calls.at(-1)).toMatchObject({ action: 'set_group_leave', params: { is_dismiss: false } })
      await checkIdle(account.id, client)
      const wrong = await registry.forwardPublicExtension(
        'channels',
        owner.handle,
        new Request(`http://local/hooks/channels/${owner.handle}/${account.id}/onebot`, {
          headers: { Upgrade: 'websocket', Authorization: 'Bearer WRONG' },
        }),
      )
      expect(wrong.status).toBe(403)
      let upgraded = false
      const right = await registry.forwardPublicExtension(
        'channels',
        owner.handle,
        new Request(`http://local/hooks/channels/${owner.handle}/${account.id}/onebot`, {
          headers: { Upgrade: 'websocket', Authorization: 'Bearer QQ_SECRET' },
        }),
        {
          upgrade: () => {
            upgraded = true
            return true
          },
        },
      )
      expect(right.status).toBe(200)
      expect(upgraded).toBe(true)
      await runAsUser(other, () => {
        expect(() => accountRow(account.id)).toThrow()
      })
      expect(calls.every((call) => call.params.is_dismiss !== true)).toBe(true)
    })
  } finally {
    await runAsUser(owner, () => service?.dispose())
    closeUserDatabase(owner.handle)
    closeUserDatabase(other.handle)
    await rm(directory, { recursive: true, force: true })
  }
}, 70000)
