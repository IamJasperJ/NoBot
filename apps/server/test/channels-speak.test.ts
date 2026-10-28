import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('双平台朗读命令：引用、最新、开关、权限、隐私与修订缓存', async () => {
  if (!process.env.SPEAK_CHANNEL_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, SPEAK_CHANNEL_CHILD: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'nobot-speak-'))
  process.env.DATA_DIR = directory
  const { channelAccountInput, channelBindingInput, createRoomInput } = await import('@nobot/shared')
  const { eq } = await import('drizzle-orm')
  const { db, newId } = await import('../src/db/client')
  const { channelActors, channelDeliveries } = await import('../src/db/schema')
  const { systemDatabase } = await import('../src/db/system-client')
  const { users } = await import('../src/db/system-schema')
  const { runAsUser, closeUserDatabase } = await import('../src/user-context')
  const registry = await import('../src/extensions/registry')
  const { createExtensionHost } = await import('../src/extensions/host')
  const { ChannelService } = await import('../src/extensions/builtin/channels/service')
  const { OneBotClient } = await import('../src/extensions/builtin/channels/adapters/onebot11/client')
  const { OneBotSendQueue } = await import('../src/extensions/builtin/channels/adapters/onebot11/transport')
  const { ttsEngines } = await import('../src/extensions/builtin/audio/tts/engines')
  const { createCharacter } = await import('../src/services/characters')
  const { createChat, loadMessage } = await import('../src/services/chats')
  const { createRoom } = await import('../src/services/rooms')
  const owner = { id: 'speak-owner', handle: 'speak-owner', name: 'Owner', isAdmin: true }
  systemDatabase()
    .insert(users)
    .values({ ...owner, passwordHash: 'unused', createdAt: Date.now() })
    .run()
  const synthesis = spyOn(ttsEngines.openai, 'synthesize').mockResolvedValue({
    bytes: new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]),
    mime: 'audio/mpeg',
  })
  try {
    await runAsUser(owner, async () => {
      await registry.ensureUserExtensions()
      const settings = {
        ttsEnabled: true,
        openaiApiKey: 'test',
        readNarration: true,
        narratorVoice: { engine: 'openai', voice: 'coral', speed: 1 },
      }
      const host = createExtensionHost(registry.emitServerEvent, () => ({
        settings,
        storage: { get: () => undefined, set: () => {}, delete: () => {} },
      }))
      const service = new ChannelService(host, () => ({}))
      let seq = 100
      const calls: { method: string; body: Record<string, unknown> }[] = []
      service.runtime.fetch = async (url, init) => {
        const method = String(url).split('/').at(-1)!
        const body =
          init?.body instanceof FormData
            ? Object.fromEntries(init.body.entries())
            : JSON.parse(String(init?.body ?? '{}'))
        calls.push({ method, body })
        return Response.json({
          ok: true,
          result:
            method === 'getMe'
              ? { id: 999, is_bot: true, username: 'speak_bot' }
              : method.startsWith('send')
                ? { message_id: ++seq, voice: { file_id: `voice-${seq}` } }
                : true,
        })
      }
      service.runtime.oneBotQueue = (config) =>
        new OneBotSendQueue(
          config.rateLimit,
          Date.now,
          async () => {},
          () => 0,
        )
      try {
        for (const provider of ['telegram', 'onebot11'] as const) {
          const character = createCharacter({ name: provider, fields: {} })
          const chat = createChat({ characterId: character.id })
          const account = await service.runtime.create(
            channelAccountInput.parse(
              provider === 'telegram'
                ? {
                    name: provider,
                    credentials: { token: 'mock', webhookSecret: 'test' },
                    receiveMode: 'webhook',
                    webhookUrl: 'https://example.test/hook',
                  }
                : {
                    provider,
                    name: provider,
                    credentials: { accessToken: 'test' },
                    connection: { mode: 'ws-reverse' },
                  },
            ),
          )
          await service.runtime.start(account.id)
          const client = service.runtime.accounts.get(account.id)!.client
          if (client instanceof OneBotClient) {
            client.transport.attach({
              close: () => {},
              send: (raw) => {
                const call = JSON.parse(raw)
                calls.push({ method: call.action, body: call.params })
                const data =
                  call.action === 'get_login_info'
                    ? { user_id: 999, nickname: 'QQ' }
                    : call.action === 'get_friend_list'
                      ? [{ user_id: 11, nickname: 'Owner' }]
                      : call.action === 'get_group_list'
                        ? []
                        : call.action === 'get_version_info'
                          ? { app_name: 'NapCat' }
                          : { message_id: ++seq }
                queueMicrotask(() => client.transport.receive({ echo: call.echo, status: 'ok', retcode: 0, data }))
              },
            })
            await Bun.sleep(0)
          }
          db.insert(channelActors)
            .values({
              id: newId(),
              provider,
              externalId: '11',
              displayName: 'Owner',
              role: 'owner',
              linkedUserId: owner.id,
              accountIds: [account.id],
              dmChatId: '11',
            })
            .run()
          let binding = {
            ...channelBindingInput.parse({
              accountId: account.id,
              scope: 'private',
              chat: '11',
              chatId: chat.id,
              state: 'active',
              trigger: 'all',
              settings: { voice: 'button' },
            }),
            id: newId(),
            createdBy: owner.id,
            lastActivityAt: Date.now(),
            idleWarnedAt: null,
          }
          service.saveBinding(binding)
          const append = (text: string) => host.appendMessage(chat.id, { role: 'assistant', content: text })
          const first = append(`First ${provider}`)
          await service.deliver(binding, first)
          const delivery = db.select().from(channelDeliveries).where(eq(channelDeliveries.messageId, first.id)).get()!
          const external = Number(delivery.parts[0]!.externalId)
          const second = append(`Latest ${provider}`)
          const originalSpeech = host.synthesizeSpeech.bind(host)
          const speech = spyOn(host, 'synthesizeSpeech')
          const send = async (text: string, quote?: number, user = 11) => {
            const id = ++seq
            await service.receive(
              account.id,
              provider === 'telegram'
                ? {
                    update_id: id,
                    message: {
                      message_id: id,
                      from: { id: user, first_name: 'Owner' },
                      chat: { id: Number(binding.chat), type: binding.scope },
                      text,
                      reply_to_message: quote === undefined ? undefined : { message_id: quote, from: { id: 999 } },
                    },
                  }
                : {
                    post_type: 'message',
                    self_id: 999,
                    user_id: user,
                    message_id: id,
                    message_type: binding.scope,
                    group_id: binding.scope === 'group' ? 11 : undefined,
                    sender: { nickname: 'Owner' },
                    message: [
                      ...(quote === undefined ? [] : [{ type: 'reply', data: { id: String(quote) } }]),
                      { type: 'text', data: { text } },
                    ],
                  },
            )
          }
          const audioCount = () =>
            calls.filter(
              (call) =>
                ['sendVoice', 'sendAudio'].includes(call.method) ||
                JSON.stringify(call.body.message ?? '').includes('"record"'),
            ).length
          const before = synthesis.mock.calls.length
          await send('/speak', external)
          expect(speech.mock.calls.at(-1)?.slice(0, 2)).toEqual([chat.id, first.id])
          const audios = audioCount()
          await send('/speak', external)
          expect(audioCount()).toBeGreaterThan(audios)
          expect(synthesis.mock.calls.length).toBe(before + 1)
          host.editMessage(first.id, `Revised ${provider}`)
          await service.deliver(binding, loadMessage(first.id))
          const revised = db.select().from(channelDeliveries).where(eq(channelDeliveries.messageId, first.id)).get()!
          await send('/speak', Number(revised.parts[0]!.externalId))
          expect(synthesis.mock.calls.length).toBe(before + 2)
          await send('/speak')
          expect(speech.mock.calls.at(-1)?.[1]).toBe(second.id)
          const count = speech.mock.calls.length
          await send('/speak', 987654)
          expect(speech.mock.calls.length).toBe(count)
          binding = { ...binding, settings: { voice: 'off' } }
          service.saveBinding(binding)
          await send('/speak')
          expect(speech.mock.calls.length).toBe(count)
          expect(JSON.stringify(calls.at(-1))).toMatch(/关闭语音|turned off/)
          binding = { ...binding, settings: { voice: 'auto' } }
          service.saveBinding(binding)
          await send('/speak')
          expect(speech.mock.calls.length).toBe(count + 1)
          settings.ttsEnabled = false
          await send('/speak')
          expect(JSON.stringify(calls.at(-1))).toMatch(/尚未配置|not configured/)
          settings.ttsEnabled = true
          await send('/help')
          expect(JSON.stringify(calls.at(-1))).toContain('/speak')
          // 使用真实平台适配器，合成结果固定为本地文件以检查投递顺序和回退。
          const audioPath = join(directory, `${provider}.mp3`)
          await Bun.write(audioPath, new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]))
          const audioResult = {
            kind: 'audio' as const,
            files: [{ path: audioPath, mime: 'audio/mpeg', text: 'spoken' }],
          }
          speech.mockResolvedValue(audioResult)
          const onlySettings = { voice: 'only' as const, voiceNarration: 'text' as const, voiceMaxChars: 8 }
          binding = { ...binding, settings: onlySettings }
          service.saveBinding(binding)
          const onlyMessage = append('<say who="Alice">One. Two. Three.</say><narration>Waves.</narration>')
          const choiceMessage = {
            ...onlyMessage,
            meta: {
              ...onlyMessage.meta,
              stage: {
                ops: [],
                beats: [
                  { kind: 'line' as const, speaker: 'Alice', text: 'One. Two. Three.' },
                  { kind: 'narration' as const, text: 'Waves.' },
                ],
                choices: [{ text: 'Go', value: 'go' }],
              },
            },
          }
          const startOnly = calls.length
          const speechStart = speech.mock.calls.length
          await service.deliver(binding, choiceMessage)
          const onlyCalls = calls.slice(startOnly)
          const onlyJson = JSON.stringify(onlyCalls)
          expect(onlyJson).not.toContain('One. Two. Three.')
          expect(onlyJson).toContain('Waves.')
          expect(onlyJson).toContain('Go')
          expect(audioCount()).toBeGreaterThan(audios)
          const spoken = speech.mock.calls.slice(speechStart).flatMap((call) => call[2]?.segments ?? [])
          expect(spoken.map((segment) => segment.text)).toEqual(['One.', 'Two.', 'Three.'])
          expect(spoken.every((segment) => segment.speaker.kind !== 'narrator')).toBe(true)
          if (provider === 'telegram') {
            expect(onlyCalls.some((call) => call.body.action === 'record_voice')).toBe(true)
            expect(onlyCalls.some((call) => ['sendMessageDraft', 'editMessageText'].includes(call.method))).toBe(false)
            expect(onlyCalls.findIndex((call) => call.method === 'sendVoice')).toBeLessThan(
              onlyCalls.findIndex((call) => call.method === 'sendMessage'),
            )
          }
          const replay = calls.length
          await service.deliver(binding, choiceMessage)
          expect(calls.length).toBe(replay)
          for (const narration of ['speak', 'drop'] as const) {
            binding = { ...binding, settings: { ...onlySettings, voiceNarration: narration } }
            service.saveBinding(binding)
            const before = speech.mock.calls.length
            const callStart = calls.length
            await service.deliver(binding, { ...choiceMessage, id: newId() })
            const segments = speech.mock.calls.slice(before).flatMap((call) => call[2]?.segments ?? [])
            expect(segments.some((segment) => segment.speaker.kind === 'narrator')).toBe(narration === 'speak')
            expect(JSON.stringify(calls.slice(callStart))).not.toContain('Waves.')
          }
          binding = { ...binding, settings: { ...onlySettings, voiceLongText: 'text' } }
          service.saveBinding(binding)
          const beforeLong = speech.mock.calls.length
          const longStart = calls.length
          await service.deliver(binding, { ...choiceMessage, id: newId() })
          expect(speech.mock.calls.length).toBe(beforeLong)
          expect(JSON.stringify(calls.slice(longStart))).toContain('One. Two. Three.')
          binding = { ...binding, settings: onlySettings }
          service.saveBinding(binding)
          const log = spyOn(service.runtime, 'log')
          for (const failure of ['unavailable', 'failure', 'partial', 'timeout'] as const) {
            if (failure === 'unavailable') speech.mockResolvedValue({ kind: 'unavailable', reason: 'tts-disabled' })
            else if (failure === 'failure' || failure === 'partial') {
              speech.mockRejectedValue(new Error('tts failed'))
              if (failure === 'partial') speech.mockResolvedValueOnce(audioResult)
            } else
              speech.mockImplementation(
                (_chat, _message, options) =>
                  new Promise((_resolve, reject) => {
                    // 缩短超时只用于验证真实取消分支，无需等待一分钟。
                    options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
                  }),
              )
            const timeout =
              failure === 'timeout' ? spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort()) : undefined
            const callStart = calls.length
            const logs = log.mock.calls.length
            await service.deliver(binding, { ...choiceMessage, id: newId() })
            timeout?.mockRestore()
            expect(JSON.stringify(calls.slice(callStart))).toContain('One. Two. Three.')
            expect(
              log.mock.calls.slice(logs).filter((call) => String(call[1]).startsWith('media.voice.')),
            ).toHaveLength(1)
          }
          log.mockRestore()
          speech.mockImplementation(originalSpeech)
          const { createGroup } = await import('../src/services/groups')
          const alice = createCharacter({
            name: 'Alice',
            extensions: { nobot_tts: { engine: 'openai', voice: 'alloy', speed: 1 } },
          })
          const bob = createCharacter({
            name: 'Bob',
            extensions: { nobot_tts: { engine: 'openai', voice: 'echo', speed: 1 } },
          })
          const cast = createGroup({
            name: 'Voice cast',
            members: [{ characterId: alice.id }, { characterId: bob.id }],
          })
          const castChat = createChat({ groupId: cast.id })
          const castMessage = host.appendMessage(castChat.id, {
            role: 'assistant',
            content: `<say who="Alice">Alice ${provider} voice.</say><say who="Bob">Bob ${provider} voice.</say>`,
          })
          const beforeCast = synthesis.mock.calls.length
          await service.media.onlyText(
            { ...binding, chatId: castChat.id, scope: 'group', chat: '-11' },
            castMessage,
            { ...service.settings(binding).values, voiceMaxChars: 300 },
            client,
            account.id,
          )
          expect(synthesis.mock.calls.slice(beforeCast).map((call) => call[0].voice)).toEqual(['alloy', 'echo'])
          const room = createRoom(createRoomInput.parse({ name: 'Speak room', chatId: chat.id }))
          binding = { ...binding, roomId: room.id, scope: 'group', chat: '-11' }
          service.saveBinding(binding)
          const privateOnly = host.appendMessage(chat.id, {
            role: 'assistant',
            content: '<say who="Alice">Private voice.</say>',
            meta: { channel: 'whisper', visibility: { level: 'self' }, author: { userId: owner.id, name: 'Owner' } },
          })
          speech.mockResolvedValue(audioResult)
          const privateStart = calls.length
          await service.deliver(binding, privateOnly)
          const privateCalls = calls.slice(privateStart)
          const privateAudio = privateCalls.filter(
            (call) =>
              ['sendVoice', 'sendAudio'].includes(call.method) ||
              JSON.stringify(call.body.message ?? '').includes('"record"'),
          )
          expect(privateAudio.length).toBeGreaterThan(0)
          expect(privateAudio.every((call) => String(call.body.chat_id ?? call.body.user_id) === '11')).toBe(true)
          expect(
            privateCalls.some((call) => String(call.body.chat_id) === '-11' || call.method === 'send_group_msg'),
          ).toBe(false)
          speech.mockImplementation(originalSpeech)
          await service.deliver(binding, loadMessage(first.id))
          const publicDelivery = db
            .select()
            .from(channelDeliveries)
            .where(eq(channelDeliveries.messageId, first.id))
            .get()!
          const groupQuote = Number(publicDelivery.parts[0]!.externalId)
          await send('/speak', groupQuote)
          const publicCount = speech.mock.calls.length
          // 已经投递的公开回复后来变成私密，旧引用也不能绕过当前可见性。
          for (const meta of [
            { hidden: { reason: 'blind' } },
            { channel: 'whisper' },
            { visibility: { level: 'self' } },
            { visibility: { level: 'gm' } },
            { visibility: { level: 'blind' } },
          ] as const) {
            host.updateMessageMeta(first.id, meta)
            await send('/speak', groupQuote)
            expect(speech.mock.calls.length).toBe(publicCount)
          }
          const privateMessage = append('SECRET')
          host.updateMessageMeta(privateMessage.id, { visibility: { level: 'self' }, channel: 'whisper' })
          const privateCount = speech.mock.calls.length
          await send('/speak')
          expect(speech.mock.calls.length).toBe(privateCount)
          expect(JSON.stringify(calls.at(-1))).not.toContain('SECRET')
          db.insert(channelActors)
            .values({
              id: newId(),
              provider,
              externalId: '22',
              displayName: 'Outsider',
              role: 'player',
              linkedUserId: owner.id,
              accountIds: [account.id],
            })
            .run()
          // 私聊只有主人可用；群房间则必须有有效房间成员身份。
          const outsider = {
            id: `${provider}-outsider`,
            handle: `${provider}-outsider`,
            name: 'Outsider',
            isAdmin: false,
          }
          systemDatabase()
            .insert(users)
            .values({ ...outsider, passwordHash: 'unused', createdAt: Date.now() })
            .run()
          db.update(channelActors).set({ linkedUserId: outsider.id }).where(eq(channelActors.externalId, '22')).run()
          await send('/speak', groupQuote, 22)
          expect(speech.mock.calls.length).toBe(privateCount)
          binding = { ...binding, roomId: null, scope: 'private', chat: '11' }
          service.saveBinding(binding)
          await send('/speak', undefined, 22)
          expect(speech.mock.calls.length).toBe(privateCount)
          speech.mockRestore()
        }
        expect(
          calls
            .filter((call) => call.method === 'setMyCommands')
            .every((call) =>
              (call.body.commands as { command: string }[]).some((command) => command.command === 'speak'),
            ),
        ).toBe(true)
      } finally {
        service.dispose()
      }
    })
  } finally {
    synthesis.mockRestore()
    closeUserDatabase(owner.handle)
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
