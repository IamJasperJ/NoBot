import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('CH1 集成：用户隔离、外部成员、房间私密投递、资料、政策、webhook 与模型生成', async () => {
  if (!process.env.CH1_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, CH1_TEST_CHILD: '1', MOCK_LLM_FETCH: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timeout = setTimeout(() => child.kill(), 30000)
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
  delete (globalThis as typeof globalThis & { __NOBOT_TEST_USER__?: string }).__NOBOT_TEST_USER__
  const directory = await mkdtemp(join(tmpdir(), 'nobot-ch1-'))
  process.env.DATA_DIR = directory
  const { channelAccountInput, apiPresetInput } = await import('@nobot/shared')
  const { eq } = await import('drizzle-orm')
  const { systemDatabase } = await import('../src/db/system-client')
  const { users, sessions } = await import('../src/db/system-schema')
  const { db, newId } = await import('../src/db/client')
  const { channelAccounts, channelActors, channelRequests, channelDeliveries, channelActions } = await import(
    '../src/db/schema'
  )
  const { runAsUser, closeUserDatabase } = await import('../src/user-context')
  const { createExtensionHost } = await import('../src/extensions/host')
  const { ensureExternalUser, cleanupExternalUsers } = await import('../src/services/external-users')
  const { hashToken, login } = await import('../src/services/auth')
  const social = await import('../src/services/social')
  const registry = await import('../src/extensions/registry')
  const { channelService } = await import('../src/extensions/builtin/channels')
  const { groupAdded, checkIdle, respondRequest } = await import('../src/extensions/builtin/channels/policies')
  const { accountRow, accountDTO, bindingRow, listBindings } = await import('../src/extensions/builtin/channels/store')
  const { createCharacter, updateCharacter, setCharacterAvatar } = await import('../src/services/characters')
  const { createChat, getChatRow } = await import('../src/services/chats')
  const rooms = await import('../src/services/rooms')
  const { asChannelActor, addChannelMember } = await import('../src/extensions/builtin/channels/rooms')
  const trpg = await import('../src/services/rooms/trpg')
  const { createServer } = await import('../src/server')
  const server = createServer()
  const owner = { id: 'channel-owner', handle: 'channel-owner', name: 'Owner', isAdmin: true }
  const other = { id: 'other-owner', handle: 'other-owner', name: 'Other', isAdmin: false }
  for (const user of [owner, other])
    systemDatabase()
      .insert(users)
      .values({ ...user, passwordHash: await Bun.password.hash('password123'), createdAt: Date.now() })
      .run()
  const run = <T>(fn: () => T) => runAsUser(owner, fn)
  const host = createExtensionHost(registry.emitServerEvent)
  const service = run(() =>
    channelService({ host, settings: {}, storage: { get: () => undefined, set: () => {}, delete: () => {} } }),
  )
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = []
  const avatarUploads: FormData[] = []
  let sequence = 100
  service.runtime.fetch = async (input, init) => {
    if (String(input).includes('/file/bot'))
      return new Response(new Uint8Array([255, 216, 255]), { headers: { 'Content-Type': 'image/jpeg' } })
    const method = String(input).split('/').at(-1)!
    if (init?.body instanceof FormData) avatarUploads.push(init.body)
    const body =
      init?.body instanceof FormData
        ? Object.fromEntries(init.body.entries())
        : (JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    calls.push({ url: String(input), method, body })
    return Response.json({
      ok: true,
      result:
        method === 'getMe'
          ? { id: 999, is_bot: true, username: 'test_bot', first_name: 'Test' }
          : method === 'getUserProfilePhotos'
            ? { photos: [[{ file_id: 'photo' }]] }
            : method === 'getFile'
              ? { file_path: 'photos/bot.jpg' }
              : method === 'getChat'
                ? { title: 'Platform location' }
                : method.startsWith('getMy')
                  ? { name: 'Current', description: 'Current', short_description: 'Current' }
                  : method === 'getChatMember'
                    ? {
                        status: 'administrator',
                        can_manage_topics: true,
                        can_pin_messages: true,
                        can_change_info: true,
                      }
                    : method === 'sendMessage'
                      ? { message_id: sequence++ }
                      : true,
    })
  }
  try {
    await run(async () => {
      const character = createCharacter({
        name: 'Alice',
        description: 'Public intro\n\nPRIVATE_CARD',
        system_prompt: 'PRIVATE_SYSTEM',
      })
      registry.updateExtension('channels', { enabled: true })
      const config = channelAccountInput.parse({
        name: 'Test',
        credentials: { token: 'TOP_SECRET', webhookSecret: 'hook-secret' },
        receiveMode: 'webhook',
        webhookUrl: 'https://example.test/hooks/channels/channel-owner/a',
        defaultCharacterId: character.id,
        presence: {
          characterId: character.id,
          name: { mode: 'follow-character' },
          description: { mode: 'follow-character' },
        },
        policies: { newLocation: { private: 'auto', group: 'auto' } },
      })
      const account = await service.runtime.create(config)
      expect(JSON.stringify(account)).not.toContain('TOP_SECRET')
      const { sealCredentials, openCredentials } = await import('../src/extensions/builtin/channels/secrets')
      const encrypted = sealCredentials({ token: 'test-encryption-secret' })
      expect(openCredentials(encrypted).token).toBe('test-encryption-secret')
      expect(sealCredentials({ token: 'test-encryption-secret' })).not.toBe(encrypted)
      const parts = encrypted.split('.')
      parts[3] = `${parts[3]![0] === 'A' ? 'B' : 'A'}${parts[3]!.slice(1)}`
      expect(() => openCredentials(parts.join('.'))).toThrow()
      runAsUser(other, () => expect(() => openCredentials(encrypted)).toThrow())

      expect(
        db.select().from(channelAccounts).where(eq(channelAccounts.id, account.id)).get()!.credentials,
      ).not.toContain('TOP_SECRET')
      const { app: channelsApp } = await import('../src/app')
      expect(account.settings).toEqual({})
      const normalFetch = service.runtime.fetch
      try {
        for (const failure of [401, 404, 'network'] as const) {
          service.runtime.fetch = async () => {
            if (failure === 'network') throw new TypeError('network secret URL')
            return Response.json({ ok: false, error_code: failure }, { status: failure })
          }
          const response = await channelsApp.request('/api/ext/channels/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Invalid', credentials: { token: 'BAD_SECRET' } }),
          })
          expect(response.status).toBe(failure === 'network' ? 502 : 400)
          const result = (await response.json()) as { error: { message: string } }
          expect(result.error.message).toBe(
            failure === 'network' ? '无法连接机器人平台，请检查网络后重试' : 'Bot Token 无效，请检查后重试',
          )
          expect(JSON.stringify(result)).not.toMatch(/BAD_SECRET|network secret URL/)
        }
      } finally {
        service.runtime.fetch = normalFetch
      }
      const stoppedResponse = await channelsApp.request(`/api/ext/channels/accounts/${account.id}/presence/preview`)
      expect(stoppedResponse.status).toBe(200)
      const stoppedPreview = (await stoppedResponse.json()) as import('@nobot/shared').ChannelPresencePreview
      expect(accountRow(account.id).status).toBe('stopped')
      expect(service.runtime.accounts.has(account.id)).toBe(false)
      expect(stoppedPreview.current).toEqual({
        name: 'Current',
        description: 'Current',
        shortDescription: 'Current',
        avatar: 'data:image/jpeg;base64,/9j/',
      })
      expect(stoppedPreview.desired).toEqual({
        name: 'Alice',
        description: 'Public intro',
        shortDescription: 'Current',
        avatar: 'data:image/jpeg;base64,/9j/',
      })
      expect(account.bindingCount).toBe(0)
      expect(account.pendingRequestCount).toBe(0)
      await service.runtime.start(account.id)
      expect(accountRow(account.id).status).toBe('online')
      expect(calls.filter((c) => c.method === 'setMyCommands')).toHaveLength(6)
      const presence = service.runtime.accounts.get(account.id)!.presence
      const preview = await presence.preview()
      expect(preview.desired.description).toBe('Public intro')
      expect(JSON.stringify(preview)).not.toContain('PRIVATE')
      expect(() => presence.apply(false)).toThrow()
      await presence.apply(true)
      const appliedCalls = calls.filter((c) => c.method.startsWith('setMy')).length
      await presence.sync()
      expect(calls.filter((c) => c.method.startsWith('setMy'))).toHaveLength(appliedCalls)
      const configured = accountRow(account.id)
      db.update(channelAccounts)
        .set({
          presence: {
            ...configured.config.presence,
            name: { mode: 'follow-character', value: '', languages: { zh: '中文名字', en: 'Public Name' } },
            avatar: { mode: 'follow-character', value: '', languages: {} },
          },
        })
        .where(eq(channelAccounts.id, account.id))
        .run()
      const sharp = (await import('sharp')).default
      const avatar = await sharp({ create: { width: 12, height: 20, channels: 3, background: '#ffffff' } })
        .png()
        .toBuffer()
      await setCharacterAvatar(character.id, avatar)
      await presence.sync(true)
      expect(
        calls.some((c) => c.method === 'setMyName' && c.body.language_code === 'zh' && c.body.name === '中文名字'),
      ).toBe(true)
      expect(
        calls.some((c) => c.method === 'setMyName' && c.body.language_code === 'en' && c.body.name === 'Public Name'),
      ).toBe(true)
      expect((avatarUploads[0]!.get('avatar') as Blob).type).toBe('image/jpeg')
      const avatarPreview = await presence.preview()
      expect(avatarPreview.desired.avatar).toBe(`/api/characters/${character.id}/avatar`)
      expect(Object.keys(avatarPreview.desired).sort()).toEqual(Object.keys(avatarPreview.current).sort())
      expect(JSON.stringify(avatarPreview)).not.toContain('TOP_SECRET')
      let debounceRuns = 0
      const realTimeout = globalThis.setTimeout
      const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation((handler, delay = 0, ...args) =>
        realTimeout(
          () => {
            if (delay === 30000) debounceRuns++
            handler(...args)
          },
          delay === 30000 ? 10 : delay,
        ),
      )
      try {
        updateCharacter(character.id, { name: 'Alice Updated' })
        service.onEvent({ type: 'character:updated', characterId: character.id })
        service.onEvent({ type: 'character:updated', characterId: character.id })
        await new Promise((resolve) => realTimeout(resolve, 150))
        expect(debounceRuns).toBe(1)
      } finally {
        timerSpy.mockRestore()
      }
      const actor = db
        .insert(channelActors)
        .values({
          id: newId(),
          provider: 'telegram',
          externalId: '12',
          displayName: 'Player',
          role: 'player',
          dmChatId: '12',
        })
        .returning()
        .get()
      const inbound = (update: number, text: string) => ({
        update_id: update,
        message: {
          message_id: update,
          chat: { id: -100, type: 'supergroup', title: 'Table' },
          from: { id: 12, first_name: 'Player' },
          text,
        },
      })
      await service.receive(account.id, inbound(1, '((out of character'))
      const binding = listBindings(account.id)[0]!
      expect(binding.roomId).toBeTruthy()
      expect(binding.title).toBe('Table')
      const topicBinding = { ...binding, id: newId(), thread: '77', isolation: 'per-topic' as const }
      service.saveBinding(topicBinding)
      await service.receive(account.id, {
        update_id: 810,
        message: {
          message_id: 810,
          chat: { id: -100, type: 'supergroup', title: 'Table' },
          from: { id: 999, is_bot: true },
          message_thread_id: 77,
          forum_topic_created: { name: 'Topic name' },
        },
      })
      expect(bindingRow(topicBinding.id).title).toBe('Topic name')
      await service.receive(account.id, {
        update_id: 811,
        message: {
          message_id: 811,
          chat: { id: -100, type: 'supergroup', title: 'Table' },
          from: { id: 999, is_bot: true },
          message_thread_id: 77,
          forum_topic_edited: { name: 'Edited topic' },
        },
      })
      expect(bindingRow(topicBinding.id).title).toBe('Edited topic')
      expect(binding.chatTitle).toBe(host.getChatInfo(binding.chatId).chat.title)
      expect(binding.memberCount).toBe(1)
      expect(accountDTO(accountRow(account.id)).bindingCount).toBe(2)
      const seenActor = db.select().from(channelActors).where(eq(channelActors.id, actor.id)).get()!
      expect(seenActor.accountIds).toEqual([account.id])
      expect(seenActor.lastSeenAt).toBeGreaterThan(0)
      db.update(channelActors).set({ role: 'blocked' }).where(eq(channelActors.id, actor.id)).run()
      expect(bindingRow(binding.id).memberCount).toBe(0)
      db.update(channelActors).set({ role: 'player' }).where(eq(channelActors.id, actor.id)).run()
      await service.receive(account.id, {
        ...inbound(800, '((rename'),
        message: {
          ...inbound(800, '((rename').message,
          chat: { id: -100, type: 'supergroup', title: 'Renamed table' },
        },
      })
      expect(bindingRow(binding.id).title).toBe('Renamed table')
      expect(bindingRow(topicBinding.id).title).toBe('Edited topic')
      await service.receive(account.id, {
        update_id: 801,
        my_chat_member: {
          chat: { id: -100, type: 'supergroup', title: 'Membership title' },
          from: { id: 42, first_name: 'Adder' },
          old_chat_member: { status: 'left' },
          new_chat_member: { status: 'member' },
        },
      })
      expect(bindingRow(binding.id).title).toBe('Membership title')
      const invitation = db
        .select()
        .from(channelRequests)
        .all()
        .find((r) => r.chat === '-100')!
      expect(invitation.actorName).toBe('Adder')
      expect(accountDTO(accountRow(account.id)).pendingRequestCount).toBe(1)
      await respondRequest(invitation.id, 'approve', service.runtime.accounts.get(account.id)!.client)
      expect(accountDTO(accountRow(account.id)).pendingRequestCount).toBe(0)
      const room = rooms.roomRow(binding.roomId!)
      rooms.updateRoom(room.id, { turnMode: 'host' })
      const updatedActor = db.select().from(channelActors).where(eq(channelActors.id, actor.id)).get()!
      expect(updatedActor.externalUserId).toBeTruthy()
      expect(rooms.members(room.id)).toHaveLength(2)
      expect(host.getChatInfo(binding.chatId).messages.at(-1)?.meta.excluded).toBe(true)
      await service.receive(account.id, inbound(1, 'duplicate'))
      expect(rooms.members(room.id)).toHaveLength(2)
      const beforeEmpty = host.getChatInfo(binding.chatId).messages.length
      const callsBeforeEmpty = calls.length
      await service.receive(account.id, inbound(8101, '\u202e\u2066'))
      expect(host.getChatInfo(binding.chatId).messages).toHaveLength(beforeEmpty)
      expect(calls.slice(callsBeforeEmpty).filter((call) => call.method === 'sendMessage')).toHaveLength(0)
      await service.receive(account.id, inbound(2, '((second'))
      expect(listBindings(account.id)).toHaveLength(2)
      expect(() =>
        asChannelActor(binding, updatedActor, () =>
          rooms.checkQuota({ ...room, guestQuota: { perHour: 0, perDay: 0 } }, updatedActor.externalUserId!),
        ),
      ).toThrow()
      const external = systemDatabase().select().from(users).where(eq(users.id, updatedActor.externalUserId!)).get()!
      expect(ensureExternalUser('telegram', owner.id, '12', 'Renamed').id).toBe(external.id)
      expect(ensureExternalUser('telegram', other.id, '12', 'Other').id).not.toBe(external.id)
      expect(social.findUserByHandle(external.handle, owner.id)).toBeNull()
      expect(() => social.requestFriend(external.id, owner.handle)).toThrow()
      expect(social.notify(external.id, 'test', null)).toBeUndefined()
      await expect(login(external.handle, 'password123', 'external-ip')).rejects.toThrow()
      const token = 'e'.repeat(64)
      systemDatabase()
        .insert(sessions)
        .values({
          tokenHash: hashToken(token),
          userId: external.id,
          renewedAt: Date.now(),
          expiresAt: Date.now() + 60000,
        })
        .run()
      expect((await server.request('/api/auth/me', { headers: { Cookie: `nobot_session=${token}` } })).status).toBe(401)
      rooms.updateRoom(room.id, { choiceMode: 'vote' })
      const secondPlayer = db
        .insert(channelActors)
        .values({
          id: newId(),
          provider: 'telegram',
          externalId: '13',
          displayName: 'Second player',
          role: 'player',
          dmChatId: '13',
        })
        .returning()
        .get()
      secondPlayer.externalUserId = addChannelMember(room.id, secondPlayer)
      db.update(channelActors)
        .set({ externalUserId: secondPlayer.externalUserId })
        .where(eq(channelActors.id, secondPlayer.id))
        .run()
      const { parseStageMessage } = await import('@nobot/core/stage')
      const choiceText = 'Choose a path.\n<choices>\n- Left\n- Right\n</choices>'
      const rawChoice = host.appendMessage(binding.chatId, { role: 'assistant', content: choiceText })
      await service.deliver(binding, rawChoice)
      expect(
        db
          .select()
          .from(channelActions)
          .all()
          .filter((a) => a.messageId === rawChoice.id && a.action === 'choice'),
      ).toHaveLength(0)
      rawChoice.meta.stage = parseStageMessage(choiceText, {
        knownNames: [],
        vars: {},
        inline: false,
        mvu: false,
      }).stage
      await service.deliver(binding, rawChoice)
      expect(
        db
          .select()
          .from(channelActions)
          .all()
          .filter((a) => a.messageId === rawChoice.id && a.action === 'choice'),
      ).toHaveLength(2)
      const choice = host.appendMessage(binding.chatId, {
        role: 'assistant',
        content: choiceText,
        meta: { stage: parseStageMessage(choiceText, { knownNames: [], vars: {}, inline: false, mvu: false }).stage },
      })
      trpg.registerChoices(rooms.roomRow(room.id), choice)
      await service.deliver(binding, choice)
      const choiceToken = db
        .select()
        .from(channelActions)
        .all()
        .find((a) => a.messageId === choice.id && a.action === 'choice' && a.args.index === 0)!
      await service.receive(account.id, {
        update_id: 150,
        callback_query: {
          id: 'vote-callback',
          from: { id: 12 },
          data: choiceToken.token,
          message: { message_id: 100, chat: { id: -100, type: 'supergroup' } },
        },
      })
      expect(trpg.choiceSnapshot(room.id, choice.id).counts).toEqual([1, 0])
      asChannelActor(binding, secondPlayer, () => trpg.pickRoomChoice(room.id, choice.id, 1))
      expect(trpg.choiceSnapshot(room.id, choice.id).counts).toEqual([1, 1])
      expect(trpg.choiceSnapshot(room.id, choice.id).closed).toBe(false)
      const diceOwner = db
        .insert(channelActors)
        .values({
          id: newId(),
          provider: 'telegram',
          externalId: '9991',
          displayName: 'Dice owner',
          role: 'owner',
          linkedUserId: owner.id,
          dmChatId: '9991',
        })
        .returning()
        .get()
      for (const [index, visibility] of ['blind', 'gm', 'self'].entries()) {
        const before = calls.length
        await service.receive(account.id, inbound(900 + index, `/roll 1d20 ${visibility}`))
        await new Promise((resolve) => setTimeout(resolve, 300))
        const sent = calls.slice(before).filter((c) => c.method === 'sendMessage')
        expect(sent.some((c) => c.body.chat_id === '-100' && String(c.body.text).includes('1d20'))).toBe(false)
        expect(sent.some((c) => c.body.chat_id === '12' && String(c.body.text).includes('1d20'))).toBe(
          visibility !== 'blind',
        )
        expect(sent.some((c) => c.body.chat_id === '9991' && String(c.body.text).includes('1d20'))).toBe(
          visibility !== 'self',
        )
        expect(sent.some((c) => c.body.chat_id === '13' && String(c.body.text).includes('1d20'))).toBe(false)
        const roll = host.getChatInfo(binding.chatId).messages.at(-1)!
        expect(roll.meta.visibility?.level).toBe(visibility)
      }
      const beforePrivate = calls.length
      asChannelActor(binding, updatedActor, () => trpg.rollRoom(room.id, { expression: '1d6', visibility: 'self' }))
      asChannelActor(binding, updatedActor, () =>
        trpg.whisperRoom(room.id, { text: 'PRIVATE_WHISPER', to: 'gm', clientMessageId: 'whisper-1' }),
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      const privateCalls = calls.slice(beforePrivate).filter((c) => c.method === 'sendMessage')
      expect(privateCalls.some((c) => c.body.chat_id === '12' && String(c.body.text).includes('1d6'))).toBe(true)
      expect(
        privateCalls.some((c) => c.body.chat_id === '-100' && /1d6|PRIVATE_WHISPER/.test(String(c.body.text))),
      ).toBe(false)
      db.update(channelActors).set({ dmChatId: null }).where(eq(channelActors.id, actor.id)).returning().get()
      for (const [index, visibility] of ['blind', 'gm', 'self'].entries()) {
        const before = calls.length
        await service.receive(account.id, inbound(910 + index, `/roll 1d6 ${visibility}`))
        await new Promise((resolve) => setTimeout(resolve, 150))
        expect(
          calls
            .slice(before)
            .some(
              (c) => c.body.chat_id === '-100' && String(c.body.text).includes('https://t.me/test_bot?start=private'),
            ),
        ).toBe(true)
        expect(calls.slice(before).some((c) => c.body.chat_id === '-100' && String(c.body.text).includes('1d6'))).toBe(
          false,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(
        calls.some(
          (c) => c.body.chat_id === '-100' && String(c.body.text).includes('https://t.me/test_bot?start=private'),
        ),
      ).toBe(true)
      db.delete(channelActors).where(eq(channelActors.id, diceOwner.id)).run()
      db.update(channelActors).set({ dmChatId: '12' }).where(eq(channelActors.id, actor.id)).run()
      rooms.updateRoom(room.id, { contentRating: 'mature', rules: 'Consent to the current room rules' })
      await service.receive(account.id, inbound(151, 'Cannot send before agreeing'))
      expect(calls.some((c) => c.body.chat_id === '12' && String(c.body.text).includes('/agree 2'))).toBe(true)
      await service.receive(account.id, inbound(152, '/agree 2'))
      expect(rooms.membership(room.id, external.id).member.acceptedRulesVersion).toBe(2)
      const api = service.runtime.accounts.get(account.id)!.client
      await groupAdded(account.id, '-200', 'Pending table', '44', api)
      const request = db.select().from(channelRequests).where(eq(channelRequests.chat, '-200')).get()!
      expect(request.state).toBe('pending')
      expect(social.listNotifications(owner.id).items.some((n) => n.type === 'channel.group.invited')).toBe(true)
      await respondRequest(request.id, 'reject', api)
      expect(calls.some((c) => c.method === 'leaveChat' && c.body.chat_id === '-200')).toBe(true)
      const old = accountRow(account.id)
      db.update(channelAccounts)
        .set({ policies: { ...old.config.policies, groupInvite: 'never' } })
        .where(eq(channelAccounts.id, account.id))
        .run()
      await groupAdded(account.id, '-300', 'Never', '12', api)
      expect(calls.some((c) => c.method === 'leaveChat' && c.body.chat_id === '-300')).toBe(true)
      const current = accountRow(account.id)
      db.update(channelAccounts)
        .set({
          policies: {
            ...current.config.policies,
            idleLeave: { enabled: true, idleDays: 1, graceDays: 1, excluded: [] },
          },
        })
        .where(eq(channelAccounts.id, account.id))
        .run()
      for (const location of listBindings(account.id)) service.saveBinding({ ...location, lastActivityAt: 0 })
      await checkIdle(account.id, api, 2 * 86400000)
      expect(listBindings(account.id)[0]?.idleWarnedAt).toBe(2 * 86400000)
      await checkIdle(account.id, api, 4 * 86400000)
      expect(listBindings(account.id)[0]?.state).toBe('left')
      cleanupExternalUsers(owner.id)
      expect(systemDatabase().select().from(users).where(eq(users.id, external.id)).get()).toBeTruthy()
      const orphan = ensureExternalUser('telegram', owner.id, 'orphan', 'Orphan')
      cleanupExternalUsers(owner.id)
      expect(systemDatabase().select().from(users).where(eq(users.id, orphan.id)).get()).toBeUndefined()
      rooms.removeMember(room.id, secondPlayer.externalUserId!, 'kicked')
      cleanupExternalUsers(owner.id)
      expect(
        systemDatabase().select().from(users).where(eq(users.id, secondPlayer.externalUserId!)).get(),
      ).toBeUndefined()

      expect(
        (
          await registry.forwardPublicExtension(
            'channels',
            'unknown',
            new Request('http://local/hooks/channels/unknown/x', { method: 'POST' }),
          )
        ).status,
      ).toBe(404)
      expect(
        (
          await registry.forwardPublicExtension(
            'channels',
            owner.handle,
            new Request(`http://local/hooks/channels/${owner.handle}/${account.id}`, {
              method: 'POST',
              headers: { 'X-Telegram-Bot-Api-Secret-Token': 'bad' },
              body: '{}',
            }),
          )
        ).status,
      ).toBe(403)
      expect(
        (
          await registry.forwardPublicExtension(
            'channels',
            owner.handle,
            new Request(`http://local/hooks/channels/${owner.handle}/${account.id}`, {
              method: 'POST',
              headers: { 'X-Telegram-Bot-Api-Secret-Token': 'hook-secret', 'Content-Type': 'application/json' },
              body: JSON.stringify({ update_id: 99 }),
            }),
          )
        ).status,
      ).toBe(200)
      const webChat = createChat({ characterId: character.id })
      const { app } = await import('../src/app')
      const attachedResponse = await app.request('/api/ext/channels/bindings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: account.id,
          scope: 'group',
          chat: '-500',
          source: 'attached',
          chatId: webChat.id,
          state: 'active',
        }),
      })
      expect(attachedResponse.status).toBe(200)
      const attached = (await attachedResponse.json()) as import('@nobot/shared').ChannelBindingDTO
      expect(attached.settings).toEqual({})
      for (const [path, settings] of [
        [`accounts/${account.id}`, { stream: false, thinking: 'fold' }],
        [`accounts/${account.id}`, { stream: true }],
        [`accounts/${account.id}`, {}],
        [`bindings/${attached.id}`, { stream: false, thinking: 'fold' }],
        [`bindings/${attached.id}`, { stream: true }],
        [`bindings/${attached.id}`, {}],
      ] as const) {
        const response = await app.request(`/api/ext/channels/${path}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings }),
        })
        expect(response.status).toBe(200)
        expect(((await response.json()) as { settings: unknown }).settings).toEqual(settings)
      }
      const inherited = await app.request(`/api/ext/channels/bindings/${attached.id}/settings`)
      expect(((await inherited.json()) as { provenance: { thinking: string } }).provenance.thinking).toBe('global')
      expect(attached.roomId).toBeTruthy()
      expect(attached.title).toBe('Platform location')
      expect(attached.chatTitle).toBe(webChat.title)
      const patchedBinding = await app.request(`/api/ext/channels/bindings/${attached.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger: 'follow-room' }),
      })
      expect(patchedBinding.status).toBe(200)
      const patched = (await patchedBinding.json()) as import('@nobot/shared').ChannelBindingDTO
      expect(patched.title).toBe(attached.title)
      expect(patched.roomId).toBe(attached.roomId)
      expect(patched.state).toBe('active')
      rooms.updateRoom(attached.roomId!, { turnMode: 'host' })
      await service.receive(account.id, {
        update_id: 160,
        message: {
          message_id: 160,
          chat: { id: -500, type: 'supergroup' },
          from: { id: 12, first_name: 'Player' },
          text: '((Platform joins the web room',
        },
      })
      expect(rooms.members(attached.roomId!)).toHaveLength(2)
      const { sendRoomMessage } = await import('../src/services/rooms/turns')
      sendRoomMessage(attached.roomId!, { text: 'Web says hello', channel: 'ic', clientMessageId: 'web-message' })
      await new Promise((resolve) => setTimeout(resolve, 180))
      expect(calls.some((c) => c.body.chat_id === '-500' && String(c.body.text).includes('Web says hello'))).toBe(true)
      const { mockLlm } = await import('./helpers/mockLlm')
      const { createApiPreset } = await import('../src/services/connections')
      const model = mockLlm()
      try {
        createApiPreset(apiPresetInput.parse({ name: 'Mock', baseUrl: model.url, model: 'mock-one' }))
        model.setScript(() => ({ text: 'Hello platform', delayMs: 2 }))
        const plain = createChat({ characterId: character.id })
        const ownerBinding = {
          ...binding,
          id: newId(),
          roomId: null,
          scope: 'private' as const,
          chat: '10',
          chatId: plain.id,
          isolation: 'dm' as const,
          state: 'active' as const,
        }
        service.saveBinding(ownerBinding)
        await service.generate(ownerBinding, { mode: 'send', text: 'Hello', images: [] })
        await host.waitIdle(plain.id, 5000)
        for (
          let i = 0;
          i < 30 &&
          !db
            .select()
            .from(channelDeliveries)
            .all()
            .some((d) => d.bindingId === ownerBinding.id);
          i++
        )
          await new Promise((resolve) => setTimeout(resolve, 50))
        expect(
          calls.some(
            (c) =>
              c.method === 'sendMessage' && c.body.chat_id === '10' && String(c.body.text).includes('Hello platform'),
          ),
        ).toBe(true)
        expect(model.requests).toHaveLength(1)
        db.insert(channelActors)
          .values({
            id: newId(),
            provider: 'telegram',
            externalId: '10',
            displayName: 'Owner',
            role: 'owner',
            linkedUserId: owner.id,
            dmChatId: '10',
          })
          .run()
        const firstDelivery = db
          .select()
          .from(channelDeliveries)
          .all()
          .find((d) => d.bindingId === ownerBinding.id)!
        const regenerate = db
          .select()
          .from(channelActions)
          .all()
          .find((a) => a.bindingId === ownerBinding.id && a.action === 'regenerate')!
        await service.receive(account.id, {
          update_id: 200,
          callback_query: {
            id: 'regen-callback',
            from: { id: 10 },
            data: regenerate.token,
            message: { message_id: Number(firstDelivery.parts[0]!.externalId), chat: { id: 10, type: 'private' } },
          },
        })
        await host.waitIdle(plain.id, 5000)
        for (
          let i = 0;
          i < 30 &&
          (db.select().from(channelDeliveries).where(eq(channelDeliveries.id, firstDelivery.id)).get()?.revision ?? 0) <
            1;
          i++
        )
          await new Promise((resolve) => setTimeout(resolve, 30))
        const revised = db.select().from(channelDeliveries).where(eq(channelDeliveries.id, firstDelivery.id)).get()!
        expect(revised.revision).toBe(1)
        expect(revised.messageId).not.toBe(firstDelivery.messageId)
        expect(revised.parts[0]?.externalId).toBe(firstDelivery.parts[0]?.externalId)
        expect(
          calls.some(
            (c) => c.method === 'editMessageText' && c.body.message_id === Number(firstDelivery.parts[0]!.externalId),
          ),
        ).toBe(true)
        expect(model.requests).toHaveLength(2)
        model.setScript(() => ({ text: 'Merged reply', delayMs: 10 }))
        await service.generate(ownerBinding, { mode: 'send', text: 'queued-one', images: [] })
        await service.generate(ownerBinding, { mode: 'send', text: 'queued-two', images: [] })
        await service.generate(ownerBinding, { mode: 'send', text: 'queued-three', images: [] })
        await host.waitIdle(plain.id, 5000)
        expect(model.requests).toHaveLength(4)
        expect(JSON.stringify(model.requests.at(-1)?.messages)).toContain('queued-two\\nqueued-three')
        model.setScript(() => ({ text: 'Long reply to stop', delayMs: 100 }))
        await service.generate(ownerBinding, { mode: 'send', text: 'start long reply', images: [] })
        await service.receive(account.id, {
          update_id: 201,
          message: {
            message_id: 201,
            chat: { id: 10, type: 'private' },
            from: { id: 10, first_name: 'Owner' },
            text: '/stop',
          },
        })
        await host.waitIdle(plain.id, 5000)
        expect(host.isGenerating(plain.id)).toBe(false)

        const secondCharacter = createCharacter({ name: 'Bob' })
        const second = await service.runtime.create({
          ...config,
          name: 'Second bot',
          credentials: { token: 'OTHER_SECRET', webhookSecret: 'other-hook' },
          characterMode: 'fixed',
          characterId: secondCharacter.id,
        })
        await service.runtime.start(second.id)
        for (const scope of ['private', 'group'] as const) {
          const fixed = {
            ...ownerBinding,
            id: newId(),
            accountId: second.id,
            scope,
            chat: scope === 'private' ? '30' : '-30',
          }
          service.saveBinding(fixed)
          for (const [speakerId, name, expected] of [
            [secondCharacter.id, 'Bob', 'Plain reply <i>waves</i>'],
            [character.id, 'Alice', 'Plain reply <i>waves</i>'],
          ]) {
            const before = calls.length
            const message = host.appendMessage(fixed.chatId, {
              role: 'assistant',
              content: 'Plain reply *waves*',
              speakerId,
              meta: { name },
            })
            await service.deliver(fixed, message)
            expect(
              calls
                .slice(before)
                .filter((c) => ['sendMessage', 'editMessageText'].includes(c.method))
                .at(-1)?.body.text,
            ).toBe(expected)
          }
        }
        const stageBinding = { ...ownerBinding, id: newId(), accountId: second.id, chat: '31' }
        service.saveBinding(stageBinding)
        const stageReply = host.appendMessage(stageBinding.chatId, {
          role: 'assistant',
          speakerId: secondCharacter.id,
          meta: { name: 'Bob' },
          content: '<say who="Bob">Hello</say> Plain *waves* <say who="Alice">Hi</say>',
        })
        const beforeStage = calls.length
        await service.deliver(stageBinding, stageReply)
        const stageHtml = String(
          calls
            .slice(beforeStage)
            .filter((c) => ['sendMessage', 'editMessageText'].includes(c.method))
            .at(-1)?.body.text,
        )
        expect(stageHtml).not.toContain('<b>Bob:')
        expect(stageHtml).not.toContain('<b>Alice: </b>')
        expect(stageHtml).toContain('<i>waves</i>')
        expect(stageHtml).not.toContain('<i> Plain')
        const genericReply = host.appendMessage(ownerBinding.chatId, {
          role: 'assistant',
          content: 'Generic reply',
          speakerId: character.id,
          meta: { name: 'Alice' },
        })
        const beforeGeneric = calls.length
        await service.deliver(ownerBinding, genericReply)
        expect(
          calls
            .slice(beforeGeneric)
            .filter((c) => ['sendMessage', 'editMessageText'].includes(c.method))
            .at(-1)?.body.text,
        ).toBe('Generic reply')
        const routed = { ...binding, state: 'active' as const, speakers: { [secondCharacter.id]: second.id } }
        service.saveBinding(routed)
        const reply = host.appendMessage(binding.chatId, {
          role: 'assistant',
          content: 'Second speaker',
          speakerId: secondCharacter.id,
          meta: { name: 'Bob' },
        })
        await service.deliver(routed, reply)
        expect(
          calls.some(
            (c) =>
              c.method === 'sendMessage' &&
              c.url.includes('OTHER_SECRET') &&
              String(c.body.text).includes('Second speaker'),
          ),
        ).toBe(true)
        expect(
          calls
            .filter(
              (call) =>
                call.url.includes('OTHER_SECRET') &&
                call.method === 'sendMessage' &&
                String(call.body.text).includes('Second speaker'),
            )
            .at(-1)?.body.text,
        ).not.toContain('Bob:')
        const speakerChat = createChat({ characterId: secondCharacter.id })
        const streamed = {
          ...ownerBinding,
          id: newId(),
          scope: 'group' as const,
          chat: '-600',
          chatId: speakerChat.id,
          isolation: 'per-user' as const,
          actor: '10',
          speakers: { [secondCharacter.id]: second.id },
          settings: { streamIntervalMs: 250 },
        }
        service.saveBinding(streamed)
        model.setScript(() => ({ text: 'Routed stream response for Bob', delayMs: 20 }))
        const startCalls = calls.length
        await service.generate(streamed, { mode: 'send', text: 'Hello Bob', images: [] })
        await host.waitIdle(speakerChat.id, 5000)
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(
          calls
            .slice(startCalls)
            .some((c) => c.url.includes('OTHER_SECRET') && c.method === 'editMessageText' && c.body.chat_id === '-600'),
        ).toBe(true)
        const onlyBinding = {
          ...streamed,
          id: newId(),
          chat: '-601',
          settings: { voice: 'only' as const, voiceNarration: 'speak' as const, stream: true, streamIntervalMs: 250 },
        }
        service.saveBinding(onlyBinding)
        const voicePath = join(directory, 'only-stream.mp3')
        await Bun.write(voicePath, new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]))
        const synthesis = spyOn(host, 'synthesizeSpeech').mockResolvedValue({
          kind: 'audio',
          files: [{ path: voicePath, mime: 'audio/mpeg', text: 'Final voice response' }],
        })
        try {
          model.setScript(() => ({ text: 'Final voice response for Bob', delayMs: 20 }))
          const voiceStart = calls.length
          await service.generate(onlyBinding, { mode: 'send', text: 'Voice only Bob', images: [] })
          await host.waitIdle(speakerChat.id, 5000)
          for (let i = 0; i < 50 && !calls.slice(voiceStart).some((call) => call.method === 'sendVoice'); i++)
            await Bun.sleep(20)
          const voiceCalls = calls.slice(voiceStart).filter((call) => String(call.body.chat_id) === '-601')
          expect(voiceCalls.some((call) => call.method === 'sendVoice')).toBe(true)
          expect(voiceCalls.some((call) => call.body.action === 'record_voice')).toBe(true)
          expect(voiceCalls.some((call) => ['sendMessageDraft', 'editMessageText'].includes(call.method))).toBe(false)
          expect(voiceCalls.some((call) => String(call.body.text).includes('Final voice response'))).toBe(false)
          expect(
            synthesis.mock.calls.flatMap((call) => call[2]?.segments ?? []).map((segment) => segment.text),
          ).toEqual(['Final voice response for Bob'])
        } finally {
          synthesis.mockRestore()
        }
        // 后台触发没有渠道入站消息，仍由 watchJobs 订阅并投递到绑定聊天。
        model.setScript(() => ({ text: 'Proactive channel greeting', delayMs: 20 }))
        const proactiveStart = calls.length
        host.trigger(plain.id, { instruction: 'Greet the channel proactively.' })
        await host.waitIdle(plain.id, 5000)
        for (
          let i = 0;
          i < 30 &&
          !calls.slice(proactiveStart).some((c) => String(c.body.text).includes('Proactive channel greeting'));
          i++
        )
          await Bun.sleep(50)
        expect(
          calls
            .slice(proactiveStart)
            .some(
              (c) =>
                ['sendMessage', 'editMessageText'].includes(c.method) &&
                c.body.chat_id === '10' &&
                String(c.body.text).includes('Proactive channel greeting'),
            ),
        ).toBe(true)
      } finally {
        model.stop()
      }
      // 通用机器人首次选择和显式切换共用菜单，选择后要求重发，避免保存附件和原始输入。
      const pickerCharacters = Array.from({ length: 10 }, (_, i) => createCharacter({ name: `Picker ${i}` }))
      const { createGroup } = await import('../src/services/groups')
      const pickerGroup = createGroup({ name: 'Picker Team', members: [{ characterId: pickerCharacters[0]!.id }] })
      const generic = await service.runtime.create(
        channelAccountInput.parse({
          name: 'Picker bot',
          credentials: { token: 'PICKER_SECRET', webhookSecret: 'picker-hook' },
          receiveMode: 'webhook',
          webhookUrl: 'https://example.test/hook',
          policies: { newLocation: { private: 'auto', group: 'auto' } },
          settings: { actorRateLimit: 1000 },
        }),
      )
      await service.runtime.start(generic.id)
      let pickerSequence = 10000
      const pickerMessage = (text: string, chat = 10, from = 10) =>
        service.receive(generic.id, {
          update_id: ++pickerSequence,
          message: {
            message_id: pickerSequence,
            chat: { id: chat, type: chat < 0 ? 'supergroup' : 'private' },
            from: { id: from, first_name: 'Picker user' },
            text,
          },
        })
      const pickerActions = () =>
        db
          .select()
          .from(channelActions)
          .all()
          .filter((a) => a.action === 'picker' && a.args.accountId === generic.id && !a.usedAt)
      const press = (token: string, chat = 10, from = 10) =>
        service.receive(generic.id, {
          update_id: ++pickerSequence,
          callback_query: {
            id: String(pickerSequence),
            data: token,
            from: { id: from, first_name: 'Picker user' },
            message: { message_id: 1, chat: { id: chat, type: chat < 0 ? 'supergroup' : 'private' } },
          },
        })
      await pickerMessage('hello', 99881, 99881)
      expect(String(calls.at(-1)?.body.text)).toContain('请先配对')
      expect(pickerActions()).toHaveLength(0)
      await pickerMessage('hello')
      expect(listBindings(generic.id)).toHaveLength(0)
      let menu = pickerActions()
      expect(menu.filter((a) => a.args.targetId)).toHaveLength(8)
      expect(menu.every((a) => a.allowedActor === '10' && a.token.length < 64 && !a.bindingId)).toBe(true)
      const next = menu.find((a) => a.args.page === 1)!
      await press(next.token, 10, 12)
      expect(listBindings(generic.id)).toHaveLength(0)
      await press(next.token)
      expect(pickerActions().some((a) => a.args.page === 0)).toBe(true)
      const firstPick = pickerActions().find((a) => a.args.targetKind === 'char')!
      await press(firstPick.token, 99999)
      expect(listBindings(generic.id)).toHaveLength(0)
      await press(firstPick.token)
      expect(getChatRow(listBindings(generic.id)[0]!.chatId).characterId).toBe(String(firstPick.args.targetId))
      expect(String(calls.at(-1)?.body.text)).toContain('重新发送')
      await pickerMessage('/char Picker 0')
      let picked = listBindings(generic.id)[0]!
      expect(getChatRow(picked.chatId).characterId).toBe(pickerCharacters[0]!.id)
      expect(String(calls.at(-1)?.body.text)).toContain('重新发送')
      await pickerMessage('/char')
      expect(pickerActions().length).toBeGreaterThan(1)
      await pickerMessage('/char pIcKeR')
      expect(pickerActions().filter((a) => a.args.targetId)).toHaveLength(8)
      await pickerMessage('/char missing-picker-name')
      expect(String(calls.at(-1)?.body.text)).toContain('没有匹配')
      await pickerMessage(`/char ${pickerCharacters[1]!.id}`)
      picked = listBindings(generic.id)[0]!
      expect(getChatRow(picked.chatId).characterId).toBe(pickerCharacters[1]!.id)
      await pickerMessage('/group')
      expect(pickerActions().some((a) => a.args.targetKind === 'group' && a.args.targetId === pickerGroup.id)).toBe(
        true,
      )
      await pickerMessage('/group pIcKeR tEaM')
      expect(getChatRow(listBindings(generic.id)[0]!.chatId).groupId).toBe(pickerGroup.id)
      await pickerMessage(`/group ${pickerGroup.id}`)
      expect(getChatRow(listBindings(generic.id)[0]!.chatId).groupId).toBe(pickerGroup.id)
      await pickerMessage('hello', -8888)
      menu = pickerActions().filter((a) => (a.args.event as { chat: { id: number } }).chat.id === -8888)
      expect(menu.length).toBeGreaterThan(0)
      await press(menu.find((a) => a.args.targetKind === 'char')!.token, -8888)
      expect(listBindings(generic.id).find((b) => b.chat === '-8888')?.roomId).toBeTruthy()
      await pickerMessage('/char', -8888, 12)
      expect(String(calls.at(-1)?.body.text)).toMatch(/权限|无法访问/)
      db.update(channelAccounts)
        .set({ characterAllowlist: [pickerCharacters[0]!.id] })
        .where(eq(channelAccounts.id, generic.id))
        .run()
      expect(accountDTO(accountRow(generic.id)).characterAllowlist).toEqual([pickerCharacters[0]!.id])
      await pickerMessage('/char')
      expect(
        pickerActions()
          .filter((a) => (a.args.event as { chat: { id: number } }).chat.id === 10 && a.args.targetKind === 'char')
          .map((a) => a.args.targetId),
      ).toEqual([pickerCharacters[0]!.id])
      await pickerMessage(`/char ${pickerCharacters[1]!.id}`)
      expect(String(calls.at(-1)?.body.text)).toContain('没有匹配')
      db.update(channelAccounts)
        .set({ characterMode: 'fixed', characterId: character.id })
        .where(eq(channelAccounts.id, account.id))
        .run()
      await service.receive(account.id, {
        update_id: ++pickerSequence,
        message: {
          message_id: pickerSequence,
          chat: { id: 10, type: 'private' },
          from: { id: 10, first_name: 'Owner' },
          text: '/char',
        },
      })
      expect(String(calls.at(-1)?.body.text)).toContain('始终扮演')
      db.update(channelAccounts).set({ characterMode: 'generic' }).where(eq(channelAccounts.id, account.id)).run()
      const { reactToMessage } = await import('../src/extensions/builtin/channels/reactions')
      picked = listBindings(generic.id)[0]!
      service.saveBinding({
        ...picked,
        settings: { reactions: true, reactionDailyBudget: 0, reactionCooldownMs: 1000 },
      })
      const reactionStart = calls.filter((c) => c.method === 'setMessageReaction').length
      const pickerClient = service.runtime.accounts.get(generic.id)!.client
      for (const now of [100000, 100001, 101001])
        await reactToMessage(service, bindingRow(picked.id), '10', 1, pickerClient, now)
      expect(calls.filter((c) => c.method === 'setMessageReaction').length - reactionStart).toBe(2)
      service.saveBinding({ ...bindingRow(picked.id), settings: { reactions: true, reactionDailyBudget: 1 } })
      await reactToMessage(service, bindingRow(picked.id), 'other', 2, pickerClient, 102002)
      expect(calls.filter((c) => c.method === 'setMessageReaction').length - reactionStart).toBe(2)
      await service.runtime.stop(generic.id)
      const rotated = await app.request(`/api/ext/channels/accounts/${account.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentials: { token: 'ROTATED_SECRET' } }),
      })
      expect(rotated.status).toBe(200)
      expect(JSON.stringify(await rotated.json())).not.toContain('ROTATED_SECRET')
      expect(accountRow(account.id).config.credentials.webhookSecret).toBe('hook-secret')
      service.dispose()
    })
    await runAsUser(other, async () => {
      registry.updateExtension('channels', { enabled: true })
      expect(
        (
          await registry.forwardPublicExtension(
            'channels',
            other.handle,
            new Request('http://local/hooks/channels/other-owner/not-owned', { method: 'POST' }),
          )
        ).status,
      ).toBe(404)
    })
  } finally {
    run(() => service.dispose())
    closeUserDatabase(owner.handle)
    closeUserDatabase(other.handle)
    await rm(directory, { recursive: true, force: true })
  }
}, 40000)
