import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('渠道原生表情：导入、学习、管理、工具、冷却、投递和隐私', async () => {
  if (!process.env.STICKER_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, STICKER_TEST_CHILD: '1', MOCK_LLM_FETCH: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, out + err).toBe(0)
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'nobot-stickers-'))
  process.env.DATA_DIR = directory
  delete (globalThis as typeof globalThis & { __NOBOT_TEST_USER__?: string }).__NOBOT_TEST_USER__
  const { channelAccountInput, channelSettingsSchema } = await import('@nobot/shared')
  const { eq } = await import('drizzle-orm')
  const { db, setSetting } = await import('../src/db/client')
  const schema = await import('../src/db/schema')
  const { systemDatabase } = await import('../src/db/system-client')
  const { users } = await import('../src/db/system-schema')
  const { runAsUser, closeUserDatabase } = await import('../src/user-context')
  const registry = await import('../src/extensions/registry')
  const { createExtensionHost } = await import('../src/extensions/host')
  const { channelService } = await import('../src/extensions/builtin/channels')
  const stickers = await import('../src/extensions/builtin/channels/stickers')
  const { stickerTools, reserveSticker } = await import('../src/extensions/builtin/channels/sticker-tool')
  const { sendMessageStickers } = await import('../src/extensions/builtin/channels/sticker-delivery')
  const { resolveSticker } = await import('../src/extensions/builtin/channels/sticker-resolution')
  const { createCharacter } = await import('../src/services/characters')
  const { createChat } = await import('../src/services/chats')
  const { accountRow, bindingRow } = await import('../src/extensions/builtin/channels/store')
  const { decodeTelegram } = await import('../src/extensions/builtin/channels/adapters/telegram/receive')
  const { decodeOneBot } = await import('../src/extensions/builtin/channels/adapters/onebot11/receive')
  const { OneBotClient } = await import('../src/extensions/builtin/channels/adapters/onebot11/client')
  const { OneBotTransport, OneBotSendQueue } = await import(
    '../src/extensions/builtin/channels/adapters/onebot11/transport'
  )
  const { QQ_FACES } = await import('../src/extensions/builtin/channels/qq-faces')
  const owner = { id: 'stickers-owner', handle: 'stickers-owner', name: 'Owner', isAdmin: true }
  systemDatabase()
    .insert(users)
    .values({ ...owner, passwordHash: 'unused', createdAt: Date.now() })
    .run()
  try {
    await runAsUser(owner, async () => {
      const host = createExtensionHost(registry.emitServerEvent)
      const ctx = { host, settings: {}, storage: { get: () => undefined, set: () => {}, delete: () => {} }, chatId: '' }
      const service = channelService(ctx)
      registry.updateExtension('channels', { enabled: true })
      const calls: { method: string; params: Record<string, unknown> }[] = []
      service.runtime.fetch = async (input, init) => {
        if (String(input).includes('/file/bot'))
          return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/webp' } })
        const method = String(input).split('/').at(-1)!
        const params = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        calls.push({ method, params })
        return Response.json({
          ok: true,
          result:
            method === 'getMe'
              ? { id: 999, is_bot: true }
              : method === 'getStickerSet'
                ? {
                    name: params.name,
                    title: 'Happy cats',
                    stickers: [
                      {
                        file_id: `${params.name}-file`,
                        file_unique_id: `${params.name}-unique`,
                        emoji: '😏',
                        type: 'regular',
                        thumbnail: { file_id: 'thumb' },
                      },
                      {
                        file_id: `${params.name}-custom`,
                        file_unique_id: `${params.name}-custom-unique`,
                        emoji: '❤️',
                        type: 'custom_emoji',
                        is_animated: true,
                      },
                    ],
                  }
                : method === 'getFile'
                  ? { file_path: 'stickers/thumb.webp' }
                  : { message_id: 10 },
        })
      }
      const actor = createCharacter({ name: 'Alice' })
      const other = createCharacter({ name: 'Bob' })
      const chat = createChat({ characterId: actor.id })
      const account = await service.runtime.create(
        channelAccountInput.parse({
          name: 'Telegram',
          credentials: { token: 'secret' },
          settings: { stickerCooldownSec: 30 },
        }),
      )
      const client = service.runtime.client(accountRow(account.id).config)
      service.runtime.accounts.set(account.id, {
        client,
        controller: new AbortController(),
        presence: service.runtime.presence(account.id),
      })
      const { app } = await import('../src/app')
      const base = `/api/ext/channels/accounts/${account.id}/stickers`
      const request = (path = '', body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
        app.request(base + path, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
      expect((await request('/sets', { name: 'https://t.me/addstickers/Cats' })).status).toBe(200)
      const listed = stickers.listStickers(account.id)
      expect(listed.count).toBe(2)
      expect(listed.groups[0]?.title).toBe('Happy cats')
      const entry = listed.groups[0]!.entries.find(
        (entry) => entry.ref.kind === 'telegram' && entry.ref.type === 'regular',
      )!
      expect(entry.meanings).toEqual(['😏', 'Happy cats'])
      expect(stickers.parseStickerSetName('Cats')).toBe('Cats')
      expect(() => stickers.parseStickerSetName('https://evil.test/addstickers/Cats')).toThrow()
      expect((await request(`/${entry.id}/preview`)).headers.get('cache-control')).toBe('private, no-store')
      expect((await request('/sets', { name: 'Dogs' })).status).toBe(200)
      const sticker = stickers.telegramStickerSchema.parse({
        file_id: 'learned',
        file_unique_id: 'learned',
        emoji: '😊',
        set_name: 'NewSet',
      })
      // 显式导入也占一分钟限额；自动学习先记单张，限流期间不抓整集。
      await stickers.learnTelegramSticker(account.id, sticker, client)
      expect(calls.filter((call) => call.method === 'getStickerSet').length).toBe(2)
      db.update(schema.channelStickerGroups).set({ attemptedAt: 0 }).run()
      expect(await stickers.learnTelegramSticker(account.id, sticker, client)).toBe('[sticker: 😊 (Happy cats)]')
      await stickers.learnTelegramSticker(account.id, sticker, client)
      expect(calls.filter((call) => call.method === 'getStickerSet').length).toBe(3)
      const noSet = { ...sticker, file_unique_id: 'single', set_name: undefined }
      await stickers.learnTelegramSticker(account.id, noSet, client)
      expect(stickers.listStickers(account.id).groups.some((group) => group.source === 'telegram-learned')).toBe(true)
      db.update(schema.channelAccounts)
        .set({ settings: { stickerMaxSets: 3 } })
        .where(eq(schema.channelAccounts.id, account.id))
        .run()
      db.update(schema.channelStickerGroups).set({ attemptedAt: 0 }).run()
      await stickers.importStickerSet(account.id, 'TooMany', client, true)
      expect(calls.filter((call) => call.method === 'getStickerSet').length).toBe(3)
      const toolsCtx = { ...ctx, chatId: chat.id, speakerId: actor.id }
      expect(stickerTools(toolsCtx, service)).toHaveLength(0)
      const binding = await app.request('/api/ext/channels/bindings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: account.id,
          chatId: chat.id,
          chat: '111',
          scope: 'private',
          title: 'DM',
          state: 'active',
        }),
      })
      expect(binding.status).toBe(200)
      const bindingId = ((await binding.json()) as { id: string }).id
      expect(stickerTools(toolsCtx, service)).toHaveLength(1)
      expect((await request(`/sets/${entry.groupId}`, { characters: [actor.id] }, 'PATCH')).status).toBe(200)
      // 其他集合仍可用；单集的专属限制严格排除 Bob。
      expect(stickers.usableStickers(account.id, other.id).some((item) => item.id === entry.id)).toBe(false)
      expect(stickers.usableStickers(account.id, actor.id).some((item) => item.id === entry.id)).toBe(true)
      const exact = { meanings: ['😏'], characters: [] }
      const exclusive = { meanings: ['😏'], characters: [actor.id] }
      expect(resolveSticker([exact, exclusive], 'smirk', () => 0)).toBe(exclusive)
      expect(resolveSticker([exact], '😏', () => 0)).toBe(exact)
      expect(resolveSticker([exact], 'nonexistent', () => 0)).toBeUndefined()
      const tool = stickerTools(toolsCtx, service)[0]!
      expect(
        (
          await tool.run(
            { mood: 'nonexistent' },
            { chatId: chat.id, speakerId: actor.id, vars: {}, signal: new AbortController().signal },
          )
        ).meta,
      ).toBeUndefined()
      const sent = await tool.run(
        { mood: 'smirk' },
        { chatId: chat.id, speakerId: actor.id, vars: {}, signal: new AbortController().signal, random: () => 0 },
      )
      expect(sent.meta?.stickers?.[0]?.ref).toEqual(entry.ref)
      expect(
        (await tool.run({ mood: '😏' }, { chatId: chat.id, vars: {}, signal: new AbortController().signal })).content,
      ).toContain('cooldown')
      const native = {
        id: 'sticker-message',
        chatId: chat.id,
        parentId: null,
        role: 'tool' as const,
        speakerId: actor.id,
        content: sent.content,
        meta: sent.meta!,
        status: 'done' as const,
        createdAt: Date.now(),
      }
      await sendMessageStickers(
        bindingRow(bindingId),
        { ...native, meta: { ...native.meta, visibility: { level: 'whisper', userIds: [] } } },
        client,
      )
      expect(calls.some((call) => call.method === 'sendSticker')).toBe(false)
      await service.deliver(bindingRow(bindingId), native)
      await service.deliver(bindingRow(bindingId), native)
      expect(calls.filter((call) => call.method === 'sendSticker')).toHaveLength(1)
      expect(calls.find((call) => call.method === 'sendSticker')?.params.sticker).toBe('Cats-file')
      expect(native.content).not.toContain('<sticker')
      const channelOwner = db
        .insert(schema.channelActors)
        .values({
          id: 'channel-owner',
          provider: 'telegram',
          externalId: '111',
          displayName: 'Owner',
          role: 'owner',
          linkedUserId: owner.id,
          dmChatId: '111',
        })
        .returning()
        .get()
      const outsider = db
        .insert(schema.channelActors)
        .values({
          id: 'outsider',
          provider: 'telegram',
          externalId: '222',
          displayName: 'Other',
          role: 'player',
          dmChatId: '222',
        })
        .returning()
        .get()
      const { createRoom } = await import('../src/services/rooms')
      const { createRoomInput } = await import('@nobot/shared')
      const { addChannelMember } = await import('../src/extensions/builtin/channels/rooms')
      const roomChat = createChat({ characterId: actor.id })
      const room = createRoom(createRoomInput.parse({ name: 'Sticker room', chatId: roomChat.id }))
      addChannelMember(room.id, channelOwner)
      addChannelMember(room.id, outsider)
      const group = {
        ...bindingRow(bindingId),
        id: 'private-sticker-binding',
        chatId: roomChat.id,
        roomId: room.id,
        scope: 'group' as const,
        chat: '-111',
        isolation: 'shared' as const,
      }
      service.saveBinding(group)
      await service.receive(account.id, {
        update_id: 2900,
        message: {
          message_id: 2900,
          chat: { id: -111, type: 'group' },
          from: { id: 333, first_name: 'Unpaired' },
          sticker: { file_id: 'unknown-face', file_unique_id: 'unknown-face', emoji: '😊' },
        },
      })
      expect(
        stickers
          .listStickers(account.id)
          .groups.flatMap((group) => group.entries)
          .some((entry) => entry.ref.kind === 'telegram' && entry.ref.file_unique_id === 'unknown-face'),
      ).toBe(true)

      const beforePrivate = calls.length
      await service.deliver(bindingRow(group.id), {
        ...native,
        id: 'whisper-sticker',
        chatId: roomChat.id,
        meta: { ...native.meta, channel: 'whisper', visibility: { level: 'whisper', userIds: [owner.id] } },
      })
      const privateStickers = calls.slice(beforePrivate).filter((call) => call.method === 'sendSticker')
      expect(privateStickers).toHaveLength(1)
      expect(privateStickers[0]?.params.chat_id).toBe('111')
      expect(
        calls.slice(beforePrivate).some((call) => call.method === 'sendSticker' && call.params.chat_id === '-111'),
      ).toBe(false)

      const budget = service.settings(bindingRow(bindingId)).values
      expect(
        reserveSticker(
          bindingRow(bindingId),
          { settings: () => ({ values: budget, provenance: {} as ReturnType<typeof service.settings>['provenance'] }) },
          Date.now() + 31000,
        ),
      ).toBe(false)
      for (let i = 0; i < 4; i++)
        db.insert(schema.messages)
          .values({
            id: `reply-${i}`,
            chatId: chat.id,
            role: 'assistant',
            content: 'reply',
            createdAt: Date.now(),
            status: 'done',
          })
          .run()
      expect(reserveSticker(bindingRow(bindingId), service, Date.now() + 31000)).toBe(true)
      db.update(schema.channelAccounts)
        .set({ settings: { stickerFrequency: 'off' } })
        .where(eq(schema.channelAccounts.id, account.id))
        .run()
      expect(stickerTools(toolsCtx, service)).toHaveLength(0)
      const { enabledToolNames } = await import('../src/tools')
      expect(enabledToolNames(chat.id, { functionCalling: false, disabledTools: [] }, actor.id)).toEqual([])
      expect((await request(`/entries/${entry.id}`, { enabled: false, characters: [actor.id] }, 'PATCH')).status).toBe(
        200,
      )
      expect(stickers.usableStickers(account.id, actor.id).some((item) => item.id === entry.id)).toBe(false)
      expect((await request(`/entries/${entry.id}`, undefined, 'DELETE')).status).toBe(200)
      expect(
        stickers
          .listStickers(account.id)
          .groups.flatMap((group) => group.entries)
          .some((item) => item.id === entry.id),
      ).toBe(false)
      expect((await request(`/sets/${entry.groupId}`, undefined, 'DELETE')).status).toBe(200)
      expect((await request('/entries/missing', { enabled: false }, 'PATCH')).status).toBe(404)
      // 真实入站 → 生成 → 动态扩展工具 → 平台投递；沙箱中直接注入 fetch，无需监听端口。
      const { createApiPreset: createMockConnection } = await import('../src/services/connections')
      createMockConnection({ name: 'Mock tools', baseUrl: 'http://sticker-model.test/v1', model: 'mock' })
      const { createPromptPreset } = await import('../src/services/promptPresets')
      const { presetDataSchema } = await import('@nobot/shared')
      const prompt = createPromptPreset({
        name: 'Sticker tools',
        data: presetDataSchema.parse({ samplers: { functionCalling: true, stream: false } }),
      })
      db.update(schema.chats).set({ promptPresetId: prompt.id }).where(eq(schema.chats.id, chat.id)).run()
      db.update(schema.channelAccounts)
        .set({ settings: { stickerFrequency: 'often', stickerCooldownSec: 0 } })
        .where(eq(schema.channelAccounts.id, account.id))
        .run()
      db.delete(schema.channelStickerCooldowns).run()
      const { mockLlmFetch } = await import('../../../scripts/mock-llm')
      const modelRequests: Record<string, unknown>[] = []
      const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const req = input instanceof Request ? input : new Request(input, init)
            modelRequests.push((await req.clone().json()) as Record<string, unknown>)
            return mockLlmFetch(req)
          },
          { preconnect: fetch.preconnect },
        ),
      )
      try {
        const beforeE2e = calls.length
        await service.receive(account.id, {
          update_id: 3000,
          message: {
            message_id: 3000,
            chat: { id: 111, type: 'private' },
            from: { id: 111, first_name: 'Owner' },
            text: 'STICKER',
          },
        })
        await host.waitIdle(chat.id, 10000)
        await Bun.sleep(300)
        expect(modelRequests.some((body) => JSON.stringify(body.tools ?? []).includes('send_sticker'))).toBe(true)
        expect(
          calls
            .slice(beforeE2e)
            .some(
              (call) =>
                call.method === 'sendSticker' && ['Dogs-file', 'NewSet-file'].includes(String(call.params.sticker)),
            ),
        ).toBe(true)
        expect(
          host
            .getChatInfo(chat.id)
            .messages.some((message) => message.role === 'tool' && message.meta.stickers?.length),
        ).toBe(true)
        const beforeDisabled = modelRequests.length
        db.update(schema.promptPresets)
          .set({ data: { ...prompt.data, samplers: { ...prompt.data.samplers, functionCalling: false } } })
          .where(eq(schema.promptPresets.id, prompt.id))
          .run()
        await service.receive(account.id, {
          update_id: 3001,
          message: {
            message_id: 3001,
            chat: { id: 111, type: 'private' },
            from: { id: 111, first_name: 'Owner' },
            text: 'STICKER',
          },
        })
        await host.waitIdle(chat.id, 10000)
        expect(modelRequests.slice(beforeDisabled).every((body) => body.tools === undefined)).toBe(true)
      } finally {
        fetchMock.mockRestore()
      }

      expect(channelSettingsSchema.parse({}).stickerAutoLabel).toBe(false)
      expect(QQ_FACES.length).toBeGreaterThanOrEqual(80)
      expect(QQ_FACES.find((face) => face.id === '264')).toEqual({ id: '264', zh: '捂脸', en: 'facepalm' })
      const qqConfig = channelAccountInput.parse({
        provider: 'onebot11',
        name: 'QQ',
        credentials: { accessToken: 'test' },
        connection: { mode: 'ws-reverse' },
      })
      const qq = await service.runtime.create(qqConfig)
      const transport = new OneBotTransport({ token: 'test', onEvent: () => {}, onStatus: () => {} })
      const qqClient = new OneBotClient(
        transport,
        qqConfig,
        undefined,
        undefined,
        new OneBotSendQueue(qqConfig.rateLimit, async () => {}),
      )
      qqClient.implementation = { name: 'NapCat', version: 'test' }
      service.runtime.accounts.set(qq.id, {
        client: qqClient,
        controller: new AbortController(),
        presence: service.runtime.presence(qq.id),
      })
      const action = spyOn(qqClient, 'call').mockImplementation(
        async <T>() => ['https://example.test/0123456789abcdef0123456789abcdef.png?token=1'] as T,
      )
      const labelController = new AbortController()
      let labelSignal: AbortSignal | undefined
      let downloadSignal: AbortSignal | undefined
      let visionCalls = 0
      let byteFetches = 0
      const completion = spyOn(host, 'complete').mockImplementation(async (opts) => {
        labelSignal = opts.signal
        visionCalls++
        expect(opts.avatar).toBeInstanceOf(Uint8Array)
        return '开心, 微笑'
      })
      const imageFetch = async (_input?: RequestInfo | URL, init?: RequestInit) => {
        downloadSignal = init?.signal ?? undefined
        byteFetches++
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })
      }
      expect(
        (await app.request(`/api/ext/channels/accounts/${qq.id}/stickers/refresh`, { method: 'POST' })).status,
      ).toBe(200)
      await stickers.refreshQqFaces(qq.id, qqClient, host, imageFetch)
      expect(visionCalls).toBe(0)
      expect(byteFetches).toBe(0)
      const { createApiPreset, setDefaultApiPreset } = await import('../src/services/connections')
      const vision = createApiPreset({
        name: 'Vision',
        baseUrl: 'http://localhost:3999/v1',
        model: 'vision',
        vision: 'yes',
      })
      setDefaultApiPreset(vision.id)
      db.update(schema.channelAccounts)
        .set({ settings: { stickerAutoLabel: true } })
        .where(eq(schema.channelAccounts.id, qq.id))
        .run()
      await stickers.refreshQqFaces(qq.id, qqClient, host, imageFetch, labelController.signal)
      labelController.abort()
      expect(labelSignal?.aborted).toBe(true)
      expect(downloadSignal?.aborted).toBe(true)
      await stickers.refreshQqFaces(qq.id, qqClient, host, imageFetch)
      expect(visionCalls).toBe(1)
      expect(byteFetches).toBe(1)
      expect(stickers.qqStickerIdentity('https://example.test/download?fileid=one&rkey=old')).toBe(
        stickers.qqStickerIdentity('https://example.test/download?rkey=new&fileid=one'),
      )
      expect(stickers.qqStickerIdentity('https://example.test/download?fileid=one')).not.toBe(
        stickers.qqStickerIdentity('https://example.test/download?fileid=two'),
      )
      expect(
        stickers.qqStickerMeaning(qq.id, {
          type: 'image',
          data: { url: 'https://example.test/0123456789abcdef0123456789abcdef.png?token=other', sub_type: 1 },
        }),
      ).toBe('开心, 微笑')
      expect(JSON.stringify(stickers.listStickers(qq.id))).not.toContain('base64')
      // 模拟临时鉴权过期：学习后预览、标注和发送都必须继续使用原始缓存字节。
      const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
      let expired = false
      let cachedFetches = 0
      const cachedFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        cachedFetches++
        expect(init?.redirect).toBe('error')
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        return expired
          ? new Response(null, { status: 400 })
          : new Response(gif, {
              headers: { 'Content-Type': 'image/gif' },
            })
      }
      const genericImage = {
        type: 'image',
        data: { url: 'https://example.test/download?fileid=cached&rkey=old', sub_type: 2, summary: '[动画表情]' },
      }
      const cachedEntry = stickers.learnQqSticker(qq.id, genericImage, { fetcher: cachedFetch, host })!
      expect(cachedEntry.meanings).toEqual([])
      // 等待学习启动的缓存，不允许第二次下载；重复缓存调用只检查已有文件。
      await stickers.cacheQqSticker(cachedEntry, cachedFetch)
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          db.select().from(schema.channelStickers).where(eq(schema.channelStickers.id, cachedEntry.id)).get()?.meanings
            .length
        )
          break
        await Bun.sleep(10)
      }
      expect(cachedFetches).toBe(1)
      expect(visionCalls).toBe(2)
      expired = true
      const cachedRow = () =>
        db.select().from(schema.channelStickers).where(eq(schema.channelStickers.id, cachedEntry.id)).get()!
      expect(cachedRow().meanings).toEqual(['开心', '微笑'])
      const cachedDto = () =>
        stickers
          .listStickers(qq.id)
          .groups.flatMap((group) => group.entries)
          .find((item) => item.id === cachedEntry.id)!
      expect(cachedDto().previewUrl).toBe(`/api/ext/channels/accounts/${qq.id}/stickers/${cachedEntry.id}/preview`)
      const preview = await app.request(cachedDto().previewUrl!)
      expect(preview.status).toBe(200)
      expect(preview.headers.get('content-type')).toBe('image/gif')
      expect(Buffer.from(await preview.arrayBuffer())).toEqual(gif)
      expect(
        (await app.request(`/api/ext/channels/accounts/${account.id}/stickers/${cachedEntry.id}/preview`)).status,
      ).toBe(404)
      // 旧版把通用 summary 当含义且已尝试过标注，列表清理后仍允许刷新补标注。
      db.update(schema.channelStickers)
        .set({ meanings: ['动画表情'], labelAttempted: true })
        .where(eq(schema.channelStickers.id, cachedEntry.id))
        .run()
      expect(cachedDto().meanings).toEqual([])
      expect(cachedRow().labelAttempted).toBe(false)
      const beforeLegacy = byteFetches
      await stickers.refreshQqFaces(qq.id, qqClient, host, imageFetch)
      expect(cachedRow().meanings).toEqual(['开心', '微笑'])
      expect(visionCalls).toBe(3)
      expect(byteFetches).toBe(beforeLegacy)
      expect(cachedFetches).toBe(1)

      // 缓存失败不能丢失引用；相同身份再收到新 URL 时更新引用并补缓存。
      const failedImage = {
        type: 'image',
        data: { url: 'https://example.test/download?fileid=retry&rkey=old', sub_type: 1, summary: '得意' },
      }
      let retryFetches = 0
      const retryFetch = async (input: RequestInfo | URL) => {
        retryFetches++
        return String(input).includes('rkey=new')
          ? new Response(gif, { headers: { 'Content-Type': 'image/gif' } })
          : new Response(null, { status: 400 })
      }
      const failed = stickers.learnQqSticker(qq.id, failedImage, { fetcher: retryFetch, host })!
      await stickers.cacheQqSticker(failed, retryFetch)
      const failedDto = () =>
        stickers
          .listStickers(qq.id)
          .groups.flatMap((group) => group.entries)
          .find((item) => item.id === failed.id)!
      expect(failedDto().previewUrl).toBe(failedImage.data.url)
      const sendCached = spyOn(qqClient, 'send').mockImplementation(async () => ({ message_id: 501 }))
      const cacheBinding = { ...bindingRow(bindingId), id: 'qq-cache-binding', accountId: qq.id }
      const sendEntry = async (id: string, ref: typeof failed.ref) =>
        sendMessageStickers(
          cacheBinding,
          { ...native, id, meta: { stickers: [{ platform: 'onebot11', mood: 'happy', ref }] } },
          qqClient,
        )
      await sendEntry('qq-cache-fallback', failedDto().ref)
      expect(sendCached.mock.calls[0]?.[1]).toEqual([
        { type: 'image', data: { file: failedImage.data.url, sub_type: 1, summary: '得意' } },
      ])
      await sendEntry('qq-cache-local', cachedDto().ref)
      expect(sendCached.mock.calls[1]?.[1]).toEqual([
        { type: 'image', data: { file: `base64://${gif.toString('base64')}`, sub_type: 2, summary: '[动画表情]' } },
      ])
      sendCached.mockRestore()
      const retried = stickers.learnQqSticker(
        qq.id,
        { ...failedImage, data: { ...failedImage.data, url: failedImage.data.url.replace('rkey=old', 'rkey=new') } },
        { fetcher: retryFetch, host },
      )!
      expect(retried.id).toBe(failed.id)
      expect(retried.ref.kind === 'image' && retried.ref.url).toContain('rkey=new')
      await stickers.cacheQqSticker(retried, retryFetch)
      expect(failedDto().previewUrl).toContain(`/stickers/${failed.id}/preview`)
      expect(retryFetches).toBe(3)

      // 下载声明和实际字节都限制在 5MB 内，拒绝非图片和重定向错误。
      for (const [name, response] of [
        ['mime', () => new Response('text', { headers: { 'Content-Type': 'text/plain' } })],
        [
          'declared-size',
          () =>
            new Response(gif, {
              headers: { 'Content-Type': 'image/gif', 'Content-Length': String(5 * 1024 * 1024 + 1) },
            }),
        ],
        [
          'stream-size',
          () => new Response(new Uint8Array(5 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'image/gif' } }),
        ],
        [
          'redirect',
          () => {
            throw new TypeError('redirect')
          },
        ],
      ] as const) {
        const segment = { type: 'image', data: { ...failedImage.data, url: `https://example.test/${name}` } }
        const entry = stickers.learnQqSticker(qq.id, segment, { fetcher: async () => response(), host })!
        await stickers.cacheQqSticker(entry, async () => response())
        expect(
          stickers
            .listStickers(qq.id)
            .groups.flatMap((group) => group.entries)
            .find((item) => item.id === entry.id)?.previewUrl,
        ).toBe(segment.data.url)
      }
      // 英文和中文占位都不进入情绪含义；保留主人输入的真实标签。
      for (const [index, summary] of ['[表情]', '[图片]', '[Animated Sticker]', '[Emoji]', '[image]'].entries()) {
        const entry = stickers.learnQqSticker(
          qq.id,
          { type: 'image', data: { ...failedImage.data, url: `https://example.test/generic-${index}`, summary } },
          { fetcher: async () => new Response(null, { status: 400 }), host },
        )!
        expect(entry.meanings).toEqual([])
        await stickers.cacheQqSticker(entry, async () => new Response(null, { status: 400 }))
      }
      completion.mockRestore()
      action.mockRestore()
      const mface = {
        type: 'mface',
        data: {
          emoji_package_id: 'pack',
          emoji_id: 'face',
          key: 'key',
          summary: '开心',
          url: 'https://example.test/mface.png',
        },
      }
      expect(stickers.learnQqSticker(qq.id, mface)?.ref.kind).toBe('mface')
      const marketImage = { ...mface, type: 'image' }
      expect(stickers.learnQqSticker(qq.id, marketImage)?.ref.kind).toBe('mface')
      const stickerImage = {
        type: 'image',
        data: { file: 'image-md5', url: 'https://example.test/face.png', sub_type: 1, summary: '微笑' },
      }
      expect(stickers.learnQqSticker(qq.id, stickerImage)?.ref.kind).toBe('image')
      expect(
        stickers.learnQqSticker(qq.id, { ...stickerImage, data: { ...stickerImage.data, sub_type: 0 } }),
      ).toBeUndefined()
      const inbound = decodeOneBot(
        {
          post_type: 'message',
          message_type: 'private',
          user_id: 111,
          self_id: 999,
          message_id: 123,
          message: [{ type: 'face', data: { id: '264' } }, mface, marketImage, stickerImage],
        },
        qqClient,
      )
      expect(inbound?.text).toContain('[表情: 捂脸]')
      expect(inbound?.text).toContain('[表情包: 开心]')
      expect(inbound?.photo).toBeUndefined()
      expect(inbound?.nativeStickers).toHaveLength(3)
      setSetting('app', { language: 'en' })
      const { setAppSettings } = await import('../src/services/settings')
      setAppSettings({ language: 'en' })
      expect(
        decodeOneBot(
          {
            post_type: 'message',
            message_type: 'private',
            user_id: 111,
            self_id: 999,
            message_id: 124,
            message: [{ type: 'face', data: { id: '264' } }],
          },
          qqClient,
        )?.text,
      ).toBe('[face: facepalm]')
      expect(
        decodeTelegram(
          { update_id: 1, message: { message_id: 1, from: { id: 1 }, chat: { id: 1, type: 'private' }, sticker } },
          {},
        )?.type,
      ).toBe('message')
      const qqBinding = { ...bindingRow(bindingId), id: 'qq-sticker-binding', accountId: qq.id }
      const sends: unknown[] = []
      const send = spyOn(qqClient, 'send').mockImplementation(async (_chat, segments) => {
        sends.push(segments)
        return { message_id: 500 }
      })
      const qqEntries = stickers.listStickers(qq.id).groups.flatMap((group) => group.entries)
      for (const kind of ['face', 'mface', 'image'] as const) {
        const item = qqEntries.find((entry) => entry.ref.kind === kind)!
        await sendMessageStickers(
          qqBinding,
          { ...native, id: `qq-${kind}`, meta: { stickers: [{ platform: 'onebot11', mood: 'happy', ref: item.ref }] } },
          qqClient,
        )
      }
      expect(sends).toHaveLength(3)
      expect(JSON.stringify(sends)).toContain('"sub_type":1')
      expect(JSON.stringify(sends)).toContain('"emoji_package_id":"pack"')
      send.mockRestore()
      service.dispose()
    })
  } finally {
    closeUserDatabase(owner.handle)
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
