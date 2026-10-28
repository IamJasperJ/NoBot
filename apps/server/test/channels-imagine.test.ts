import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('频道 imagine：共用命令、异步媒体、菜单绑定、房间额度与安全错误', async () => {
  if (!process.env.IMAGINE_CHANNEL_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, IMAGINE_CHANNEL_CHILD: '1' },
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
  delete (globalThis as typeof globalThis & { __NOBOT_TEST_USER__?: string }).__NOBOT_TEST_USER__
  const directory = await mkdtemp(join(tmpdir(), 'nobot-imagine-'))
  process.env.DATA_DIR = directory
  const { channelAccountInput, channelBindingInput } = await import('@nobot/shared')
  const { db, newId } = await import('../src/db/client')
  const { channelActors, channelActions, roomUsage, generationLogs } = await import('../src/db/schema')
  const { systemDatabase } = await import('../src/db/system-client')
  const { users, roomMembers } = await import('../src/db/system-schema')
  const { runAsUser, closeUserDatabase } = await import('../src/user-context')
  const registry = await import('../src/extensions/registry')
  const { createExtensionHost } = await import('../src/extensions/host')
  const { channelService } = await import('../src/extensions/builtin/channels')
  const { createCharacter } = await import('../src/services/characters')
  const { createGroup } = await import('../src/services/groups')
  const { createChat, getChatRow, loadPath } = await import('../src/services/chats')
  const rooms = await import('../src/services/rooms')
  const { createRoomInput } = await import('@nobot/shared')
  const owner = { id: 'imagine-owner', handle: 'imagine-owner', name: 'Owner', isAdmin: true }
  systemDatabase()
    .insert(users)
    .values({ ...owner, passwordHash: 'unused', createdAt: Date.now() })
    .run()
  const png = await (await import('sharp'))
    .default({ create: { width: 8, height: 8, channels: 3, background: '#abc' } })
    .png()
    .toBuffer()
  const { mockLlmFetch } = await import('../../../scripts/mock-llm')
  let harness = false
  let invalidPrompt = false
  let promptRequests = 0
  let fail = false
  let unblock: (() => void) | undefined
  let gate: Promise<void> | undefined
  let imageRequests = 0
  const mock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (harness) {
          const request = new Request(input, init)
          if (new URL(request.url).pathname === '/v1/chat/completions') {
            promptRequests++
            if (invalidPrompt)
              return Response.json({ choices: [{ message: { role: 'assistant', content: '<scene bg="harbor" />' } }] })
          }
          return mockLlmFetch(request)
        }
        imageRequests++
        await gate
        if (fail) return Response.json({ error: { message: 'TOP_SECRET upstream stack' } }, { status: 500 })
        return Response.json({ data: [{ b64_json: png.toString('base64') }] })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  try {
    await runAsUser(owner, async () => {
      await registry.ensureUserExtensions()
      registry.updateExtension('channels', { enabled: true })
      registry.updateExtension('image-gen', {
        enabled: true,
        settings: {
          source: 'openai',
          openaiBaseUrl: 'http://image.test/v1',
          openaiApiKey: 'TOP_SECRET',
          async: true,
          refineModelPrompts: false,
        },
      })
      const host = createExtensionHost(registry.emitServerEvent)
      const service = channelService({
        host,
        settings: {},
        storage: { get: () => undefined, set: () => {}, delete: () => {} },
      })
      const calls: { method: string; body: Record<string, unknown> }[] = []
      let seq = 100
      service.runtime.fetch = async (url, init) => {
        const method = String(url).split('/').at(-1)!
        const body =
          init?.body instanceof FormData
            ? Object.fromEntries(init.body.entries())
            : (JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
        calls.push({ method, body })
        return Response.json({
          ok: true,
          result:
            method === 'getMe'
              ? { id: 999, is_bot: true, username: 'imagine_bot', first_name: 'Image' }
              : method === 'sendMessage'
                ? { message_id: ++seq }
                : true,
        })
      }
      try {
        const alice = createCharacter({ name: 'Alice' })
        const bob = createCharacter({ name: 'Bob' })
        const group = createGroup({ name: 'Artists', members: [{ characterId: alice.id }, { characterId: bob.id }] })
        const chat = createChat({ groupId: group.id })
        const account = await service.runtime.create(
          channelAccountInput.parse({
            name: 'Image',
            credentials: { token: 'test', webhookSecret: 'hook' },
            receiveMode: 'webhook',
            webhookUrl: 'https://test.test/hook',
            defaultCharacterId: alice.id,
            settings: { actorRateLimit: 1000, generatedImages: 'spoiler' },
          }),
        )
        await service.runtime.start(account.id)
        db.insert(channelActors)
          .values({
            id: newId(),
            provider: 'telegram',
            externalId: '111',
            linkedUserId: owner.id,
            displayName: 'Owner',
            role: 'owner',
            accountIds: [account.id],
          })
          .run()
        const binding = {
          ...channelBindingInput.parse({
            accountId: account.id,
            scope: 'private',
            chat: '111',
            chatId: chat.id,
            isolation: 'dm',
            state: 'active',
          }),
          id: newId(),
          lastActivityAt: Date.now(),
          idleWarnedAt: null,
          createdBy: owner.id,
        }
        service.saveBinding(binding)
        const send = (text: string) =>
          service.receive(account.id, {
            update_id: ++seq,
            message: {
              message_id: seq,
              chat: { id: 111, type: 'private' },
              from: { id: 111, first_name: 'Owner' },
              text,
            },
          })
        const actions = () =>
          db
            .select()
            .from(channelActions)
            .all()
            .filter((a) => a.action === 'imagine' && !a.usedAt)
        const press = (token: string, from = 111) =>
          service.receive(account.id, {
            update_id: ++seq,
            callback_query: {
              id: String(seq),
              data: token,
              from: { id: from, first_name: 'User' },
              message: { message_id: 1, chat: { id: 111, type: 'private' } },
            },
          })
        const wait = async (condition: () => boolean) => {
          for (let i = 0; i < 220 && !condition(); i++) await Bun.sleep(30)
          expect(condition(), JSON.stringify(loadPath(getChatRow(chat.id).activeLeafId).at(-1)?.meta)).toBe(true)
        }
        // 与真实运行脚本使用同一个模拟服务处理器，避免通用图片桩掩盖提示词生成失败。
        const { apiPresetInput } = await import('@nobot/shared')
        const { createApiPreset } = await import('../src/services/connections')
        createApiPreset(apiPresetInput.parse({ name: 'Mock', baseUrl: 'http://image.test/v1', model: 'mock-a' }))
        host.appendMessage(chat.id, { role: 'user', content: 'VN Please describe the harbor.' })
        registry.updateExtension('image-gen', {
          settings: { source: 'openai', openaiBaseUrl: 'http://image.test/v1', openaiApiKey: 'local-test' },
        })
        harness = true
        for (const text of ['/imagine 场景', '/imagine 自由描述的一只猫']) {
          const photos = calls.filter((c) => c.method === 'sendPhoto').length
          await send(text)
          await wait(() => calls.filter((c) => c.method === 'sendPhoto').length > photos)
          expect(loadPath(getChatRow(chat.id).activeLeafId).at(-1)?.meta).toMatchObject({
            clientMessageId: 'imagine',
            imageGen: { status: 'done' },
            images: [expect.anything()],
          })
        }
        expect(promptRequests).toBe(2)
        invalidPrompt = true
        await send('/imagine 场景')
        await wait(() => loadPath(getChatRow(chat.id).activeLeafId).at(-1)?.meta.imageGen?.status === 'error')
        expect(
          db
            .select()
            .from(generationLogs)
            .all()
            .some(
              (log) =>
                log.kind === 'image' &&
                log.status === 'error' &&
                (log.response as { stage?: string; error?: string })?.stage === 'prompt' &&
                (log.response as { error?: string })?.error?.includes('模型没有返回可用的图片提示词'),
            ),
        ).toBe(true)
        invalidPrompt = false
        harness = false
        calls.length = 0
        registry.updateExtension('image-gen', {
          settings: {
            source: 'openai',
            openaiBaseUrl: 'http://image.test/v1',
            openaiApiKey: 'TOP_SECRET',
            refineModelPrompts: false,
          },
        })
        await send('/imagine')
        expect(actions()).toHaveLength(9)
        expect(actions().every((a) => a.token.length < 64 && a.allowedActor === '111')).toBe(true)
        const full = actions().find((a) => a.args.input === 'character')!
        await press(full.token, 222)
        expect(actions().some((a) => a.token === full.token)).toBe(true)
        await press(full.token)
        expect(actions()).toHaveLength(2)
        expect(actions().some((a) => String(a.args.input).includes('Bob'))).toBe(true)
        gate = new Promise<void>((resolve) => {
          unblock = resolve
        })
        await send('/imagine free a cat')
        await wait(() => imageRequests > 0)
        await wait(() => calls.some((c) => c.method === 'sendChatAction' && c.body.action === 'upload_photo'))
        expect(calls.some((c) => c.method === 'sendPhoto')).toBe(false)
        await wait(() => calls.some((c) => c.method === 'sendMessage' && c.body.text === '🎨 正在画…'))
        expect(
          calls.filter((c) => c.method === 'sendChatAction' && c.body.action === 'upload_photo').length,
        ).toBeGreaterThanOrEqual(2)
        unblock!()
        gate = undefined
        await wait(() => calls.some((c) => c.method === 'sendPhoto'))
        expect(calls.find((c) => c.method === 'sendPhoto')?.body.has_spoiler).toBe('true')
        expect(calls.some((c) => c.method === 'deleteMessage')).toBe(true)
        expect(loadPath(getChatRow(chat.id).activeLeafId).at(-1)?.meta.images).toHaveLength(1)
        const count = calls.filter((c) => c.method === 'sendPhoto').length
        service.saveBinding({ ...binding, settings: { generatedImages: 'off' } })
        await send('/sd free another cat')
        await wait(() => calls.filter((c) => c.method === 'sendPhoto').length > count)
        fail = true
        await send('/imagine free failure')
        await wait(() => calls.some((c) => String(c.body.text).includes('图片生成失败')))
        expect(JSON.stringify(calls)).not.toContain('TOP_SECRET')
        const errors = db
          .select()
          .from(generationLogs)
          .all()
          .filter((log) => log.kind === 'image' && log.status === 'error')
        expect(errors.some((log) => JSON.stringify(log.response).includes('upstream stack'))).toBe(true)
        expect(JSON.stringify(errors)).not.toContain('TOP_SECRET')
        const { setAppSettings } = await import('../src/services/settings')
        setAppSettings({ language: 'en' })
        await send('/imagine free failure in English')
        await wait(() => calls.some((c) => String(c.body.text).includes('Image generation failed')))
        setAppSettings({ language: 'zh' })
        registry.updateExtension('image-gen', { enabled: false })
        await send('/imagine free cat')
        expect(calls.some((c) => String(c.body.text).includes('图片生成尚未配置或未启用'))).toBe(true)
        registry.updateExtension('image-gen', { enabled: true })
        fail = false
        // 房间沿用网页权限和图片账本；owner 也计量，但不受访客额度限制。
        const room = rooms.createRoom(
          createRoomInput.parse({ chatId: chat.id, name: 'Image room', guestQuota: { perHour: 0, perDay: 0 } }),
        )
        service.saveBinding({ ...binding, roomId: room.id })
        const groupBinding = {
          ...binding,
          id: newId(),
          roomId: room.id,
          scope: 'group' as const,
          chat: '-111',
          isolation: 'shared' as const,
        }
        service.saveBinding(groupBinding)
        await service.receive(account.id, {
          update_id: ++seq,
          message: {
            message_id: seq,
            chat: { id: -111, type: 'supergroup' },
            from: { id: 111, first_name: 'Owner' },
            text: '/imagine face',
          },
        })
        expect(actions().filter((a) => a.bindingId === groupBinding.id)).toHaveLength(2)

        const roomPhotos = calls.filter((c) => c.method === 'sendPhoto').length
        await send('/imagine free room cat')
        await wait(() => calls.filter((c) => c.method === 'sendPhoto').length > roomPhotos)
        await wait(() =>
          db
            .select()
            .from(roomUsage)
            .all()
            .some((r) => r.roomId === room.id && r.kind === 'image'),
        )
        expect(
          db
            .select()
            .from(roomUsage)
            .all()
            .filter((r) => r.roomId === room.id),
        ).toHaveLength(1)
        await wait(() => calls.some((c) => c.method === 'sendPhoto' && c.body.chat_id === '-111'))
        const { ensureExternalUser } = await import('../src/services/external-users')
        const guest = ensureExternalUser('telegram', owner.id, '222', 'Guest')
        systemDatabase()
          .insert(roomMembers)
          .values({
            roomId: room.id,
            userId: guest.id,
            role: 'spectator',
            personaName: 'Guest',
            personaDescription: '',
            state: 'active',
            acceptedRulesVersion: 1,
            joinedAt: Date.now(),
          })
          .run()
        db.insert(channelActors)
          .values({
            id: newId(),
            provider: 'telegram',
            externalId: '222',
            externalUserId: guest.id,
            displayName: 'Guest',
            role: 'player',
            accountIds: [account.id],
          })
          .run()
        const beforeGuest = imageRequests
        await service.receive(account.id, {
          update_id: ++seq,
          message: {
            message_id: seq,
            chat: { id: 111, type: 'private' },
            from: { id: 222, first_name: 'Guest' },
            text: '/imagine free denied',
          },
        })
        expect(imageRequests).toBe(beforeGuest)
        expect(calls.some((c) => String(c.body.text).includes('没有图片生成权限'))).toBe(true)
        expect(() => rooms.checkQuota(rooms.roomRow(room.id), guest.id)).toThrow('房间生成额度')
        const { eq } = await import('drizzle-orm')
        systemDatabase().update(roomMembers).set({ role: 'player' }).where(eq(roomMembers.userId, guest.id)).run()
        await service.receive(account.id, {
          update_id: ++seq,
          message: {
            message_id: seq,
            chat: { id: 111, type: 'private' },
            from: { id: 222, first_name: 'Guest' },
            text: '/imagine free player denied',
          },
        })
        expect(imageRequests).toBe(beforeGuest)
        db.update(channelActors).set({ role: 'blocked' }).where(eq(channelActors.externalId, '222')).run()
        await service.receive(account.id, {
          update_id: ++seq,
          message: {
            message_id: seq,
            chat: { id: 111, type: 'private' },
            from: { id: 222, first_name: 'Guest' },
            text: '/sd free blocked',
          },
        })
        expect(imageRequests).toBe(beforeGuest)
      } finally {
        service.dispose()
      }
    })
  } finally {
    unblock?.()
    mock.mockRestore()
    closeUserDatabase(owner.handle)
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
