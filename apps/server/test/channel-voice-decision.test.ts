import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('渠道角色语音决策：工具、规则、额度、偏好、双平台与真实生成', async () => {
  if (!process.env.VOICE_DECISION_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, VOICE_DECISION_CHILD: '1', DELAY: '0' },
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
  const directory = await mkdtemp(join(tmpdir(), 'nobot-voice-decision-'))
  process.env.DATA_DIR = directory
  delete (globalThis as typeof globalThis & { __NOBOT_TEST_USER__?: string }).__NOBOT_TEST_USER__
  const { channelAccountInput, channelBindingInput, presetDataSchema } = await import('@nobot/shared')
  const { eq } = await import('drizzle-orm')
  const { db, newId } = await import('../src/db/client')
  const schema = await import('../src/db/schema')
  const { systemDatabase } = await import('../src/db/system-client')
  const { users } = await import('../src/db/system-schema')
  const { runAsUser, closeUserDatabase } = await import('../src/user-context')
  const registry = await import('../src/extensions/registry')
  const { createExtensionHost } = await import('../src/extensions/host')
  const { channelService } = await import('../src/extensions/builtin/channels')
  const voice = await import('../src/extensions/builtin/channels/voice-decision')
  const { bindingRow } = await import('../src/extensions/builtin/channels/store')
  const { createCharacter } = await import('../src/services/characters')
  const { createChat } = await import('../src/services/chats')
  const { createGroup } = await import('../src/services/groups')
  const { OneBotClient } = await import('../src/extensions/builtin/channels/adapters/onebot11/client')
  const { OneBotSendQueue } = await import('../src/extensions/builtin/channels/adapters/onebot11/transport')
  const owner = { id: 'voice-owner', handle: 'voice-owner', name: 'Owner', isAdmin: true }
  systemDatabase()
    .insert(users)
    .values({ ...owner, passwordHash: 'unused', createdAt: Date.now() })
    .run()
  try {
    await runAsUser(owner, async () => {
      await registry.ensureUserExtensions()
      registry.updateExtension('channels', { enabled: true })
      registry.updateExtension('audio', {
        enabled: true,
        settings: { ttsEnabled: true, openaiApiKey: 'test', genderMatch: false },
      })
      const host = createExtensionHost(() => {})
      const ctx = { host, settings: {}, storage: { get: () => undefined, set: () => {}, delete: () => {} }, chatId: '' }
      const service = channelService(ctx)
      const calls: { method: string; body: Record<string, unknown> }[] = []
      let seq = 10
      service.runtime.fetch = async (input, init) => {
        const method = String(input).split('/').at(-1)!
        const body =
          init?.body instanceof FormData
            ? Object.fromEntries(init.body.entries())
            : JSON.parse(String(init?.body ?? '{}'))
        calls.push({ method, body })
        return Response.json({
          ok: true,
          result: method === 'getMe' ? { id: 999, is_bot: true } : { message_id: ++seq },
        })
      }
      service.runtime.oneBotQueue = (config) =>
        new OneBotSendQueue(
          config.rateLimit,
          Date.now,
          async () => {},
          () => 0,
        )
      const actor = createCharacter({
        name: 'Assistant',
        extensions: { nobot_tts: { engine: 'openai', voice: 'coral', speed: 1 } },
      })
      const other = createCharacter({
        name: 'Bob',
        extensions: { nobot_tts: { engine: 'openai', voice: 'onyx', speed: 1 } },
      })
      const chat = createChat({ characterId: actor.id })
      const group = createGroup({ name: 'Pair', members: [{ characterId: actor.id }, { characterId: other.id }] })
      const groupChat = createChat({ groupId: group.id })
      const file = join(directory, 'voice.mp3')
      await Bun.write(file, new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]))
      const synth = spyOn(service.host, 'synthesizeSpeech').mockResolvedValue({
        kind: 'audio',
        files: [{ path: file, mime: 'audio/mpeg', text: 'Hello', speakerId: actor.id, speakerName: 'Assistant' }],
      })
      const { app } = await import('../src/app')
      try {
        for (const provider of ['telegram', 'onebot11'] as const) {
          const account = await service.runtime.create(
            channelAccountInput.parse(
              provider === 'telegram'
                ? {
                    name: provider,
                    credentials: { token: 'test', webhookSecret: 'secret' },
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
                    : call.action === 'get_version_info'
                      ? { app_name: 'NapCat' }
                      : call.action === 'get_group_list' || call.action === 'get_friend_list'
                        ? []
                        : { message_id: ++seq }
                queueMicrotask(() => client.transport.receive({ echo: call.echo, status: 'ok', retcode: 0, data }))
              },
            })
            await Bun.sleep(0)
          }
          const raw = {
            ...channelBindingInput.parse({
              accountId: account.id,
              scope: 'private',
              chat: '111',
              chatId: chat.id,
              state: 'active',
              trigger: 'all',
              settings: { voice: 'decide', voiceNarration: 'speak' },
            }),
            id: newId(),
            createdBy: owner.id,
            lastActivityAt: Date.now(),
            idleWarnedAt: null,
          }
          service.saveBinding(raw)
          let binding = bindingRow(raw.id)
          const toolsCtx = { ...ctx, chatId: chat.id, speakerId: actor.id }
          expect(voice.voiceTools({ ...toolsCtx, chatId: '' }, service)).toHaveLength(0)
          expect(voice.voiceTools(toolsCtx, service)).toHaveLength(1)
          const blank = createCharacter({ name: 'Silent' })
          expect(voice.speakerTtsAvailable(chat.id, blank.id)).toBe(false)
          const append = (text: string, meta = {}, speakerId = actor.id) =>
            host.appendMessage(binding.chatId, {
              role: 'assistant',
              content: text,
              speakerId,
              meta: { name: speakerId === actor.id ? 'Assistant' : 'Bob', ...meta },
            })
          const audio = (start: number) =>
            calls
              .slice(start)
              .filter((call) => call.method === 'sendVoice' || JSON.stringify(call.body).includes('"type":"record"'))
          const textCalls = (start: number) =>
            calls
              .slice(start)
              .filter((call) =>
                ['sendMessage', 'editMessageText', 'send_private_msg', 'send_group_msg'].includes(call.method),
              )
          for (const scope of ['private', 'group'] as const) {
            binding = { ...binding, scope, chat: scope === 'private' ? '111' : '-111' }
            service.saveBinding(binding)
            const start = calls.length
            await service.deliver(binding, append('Hello'))
            expect(JSON.stringify(textCalls(start))).not.toContain('Assistant:')
          }
          binding = { ...binding, chatId: groupChat.id }
          service.saveBinding(binding)
          let start = calls.length
          await service.deliver(binding, append('Group reply'))
          expect(JSON.stringify(textCalls(start)), JSON.stringify(calls.slice(start))).toContain('Assistant:')
          db.update(schema.channelAccounts)
            .set({ characterMode: 'fixed', characterId: actor.id })
            .where(eq(schema.channelAccounts.id, account.id))
            .run()
          start = calls.length
          await service.deliver(binding, append('Fixed reply'))
          expect(JSON.stringify(textCalls(start))).not.toContain('Assistant:')
          db.update(schema.channelAccounts)
            .set({ characterMode: 'generic', characterId: null })
            .where(eq(schema.channelAccounts.id, account.id))
            .run()
          binding = { ...binding, speakers: { [actor.id]: account.id } }
          service.saveBinding(binding)
          start = calls.length
          await service.deliver(binding, append('Mapped reply'))
          expect(JSON.stringify(textCalls(start))).not.toContain('Assistant:')
          binding = { ...binding, chatId: chat.id, scope: 'private', chat: '111', speakers: {} }
          service.saveBinding(binding)
          for (const style of ['only', 'with-text'] as const) {
            const result = await voice
              .voiceTools(toolsCtx, service)[0]!
              .run({ style }, { chatId: chat.id, speakerId: actor.id, vars: {} })
            host.appendMessage(chat.id, {
              role: 'tool',
              content: result.content,
              speakerId: actor.id,
              meta: result.meta,
            })
            start = calls.length
            const reply = append('Voice chosen')
            await service.deliver(binding, reply)
            expect(
              audio(start),
              JSON.stringify({
                calls: calls.slice(start),
                result,
                chosen: voice.replyVoiceStyle(binding, reply, service.settings(binding).values),
                available: voice.speakerTtsAvailable(chat.id, actor.id),
                logs: service.runtime.logs,
              }),
            ).toHaveLength(1)
            expect(JSON.stringify(calls.slice(start))).not.toContain('Assistant:')
            expect(JSON.stringify(textCalls(start)).includes('Voice chosen')).toBe(style === 'with-text')
          }
          // 后续角色不能继承前一个角色的工具意图。
          binding = { ...binding, chatId: groupChat.id }
          service.saveBinding(binding)
          host.appendMessage(groupChat.id, {
            role: 'tool',
            content: 'queued',
            speakerId: actor.id,
            meta: { channelVoice: { bindingIds: [binding.id], style: 'only' } },
          })
          start = calls.length
          await service.deliver(binding, append('Bob text', {}, other.id))
          expect(audio(start)).toHaveLength(0)
          host.appendMessage(groupChat.id, {
            role: 'tool',
            content: 'queued',
            speakerId: other.id,
            meta: { channelVoice: { bindingIds: [binding.id], style: 'only' } },
          })
          start = calls.length
          await service.deliver(
            binding,
            append('<say who="Bob">My voice</say><say who="Assistant">Other voice</say>', {}, other.id),
          )
          expect(audio(start)).toHaveLength(1)
          const segments = synth.mock.calls.at(-1)?.[2]?.segments ?? []
          expect(segments.map((segment) => segment.speaker)).toEqual([{ kind: 'character', characterId: other.id }])
          binding = { ...binding, chatId: chat.id }
          service.saveBinding(binding)
          for (const mode of ['decide', 'button', 'off'] as const) {
            binding = { ...binding, settings: { voice: mode, voiceNarration: 'speak' } }
            service.saveBinding(binding)
            host.appendMessage(chat.id, { role: 'user', content: '发语音' })
            start = calls.length
            await service.deliver(binding, append('Requested voice'))
            expect(audio(start).length).toBe(mode === 'off' ? 0 : 1)
          }
          registry.updateExtension('audio', { enabled: false })
          binding = { ...binding, settings: { voice: 'decide' } }
          service.saveBinding(binding)
          expect(voice.voiceTools(toolsCtx, service)).toHaveLength(0)
          host.appendMessage(chat.id, { role: 'user', content: '发语音' })
          start = calls.length
          await service.deliver(binding, append('No TTS fallback'))
          expect(audio(start)).toHaveLength(0)
          expect(JSON.stringify(textCalls(start))).toContain('No TTS fallback')
          registry.updateExtension('audio', { enabled: true })
          binding = { ...binding, settings: { voice: 'decide', voiceDecideHourlyMax: 1 } }
          service.saveBinding(binding)
          expect(voice.voiceTools(toolsCtx, service)).toHaveLength(0)
          start = calls.length
          await service.deliver(binding, append('Capped reply'))
          expect(audio(start)).toHaveLength(0)
          expect(voice.voiceBudgetAvailable(binding.id, 1, Date.now() + 3600001)).toBe(true)
          binding = { ...binding, settings: { voice: 'decide', voiceDecideHourlyMax: 0 } }
          service.saveBinding(binding)
          voice.updateVoicePreference(binding, '多发语音', service.settings(binding).values)
          expect(bindingRow(binding.id).voicePreference?.bias).toBe('high')
          voice.updateVoicePreference(binding, '别发语音', service.settings(binding).values)
          expect(voice.voiceTools(toolsCtx, service)).toHaveLength(0)
          expect(bindingRow(binding.id).voicePreference?.suppressed).toBe(true)
          host.appendMessage(chat.id, { role: 'user', content: '发语音' })
          start = calls.length
          await service.deliver(binding, append('Suppressed reply'))
          expect(audio(start)).toHaveLength(0)
          voice.updateVoicePreference(binding, '可以发语音', service.settings(binding).values)
          expect(voice.voiceTools(toolsCtx, service)).toHaveLength(1)
          voice.updateVoicePreference(binding, '别发语音', service.settings(binding).values)
          const reset = await app.request(`/api/ext/channels/bindings/${binding.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voicePreference: null }),
          })
          expect(reset.status).toBe(200)
          expect(bindingRow(binding.id).voicePreference).toBeNull()
          expect(voice.voiceTools(toolsCtx, service)).toHaveLength(1)
          if (provider === 'telegram') {
            db.insert(schema.channelActors)
              .values({
                id: newId(),
                provider,
                externalId: '111',
                displayName: 'Owner',
                role: 'owner',
                linkedUserId: owner.id,
                accountIds: [account.id],
                dmChatId: '111',
              })
              .run()
            const { createApiPreset } = await import('../src/services/connections')
            const { createPromptPreset } = await import('../src/services/promptPresets')
            createApiPreset({ name: 'Voice mock', baseUrl: 'http://voice-model.test/v1', model: 'mock' })
            const prompt = createPromptPreset({
              name: 'Voice tools',
              data: presetDataSchema.parse({ samplers: { functionCalling: true, stream: false } }),
            })
            db.update(schema.chats).set({ promptPresetId: prompt.id }).where(eq(schema.chats.id, chat.id)).run()
            const { mockLlmFetch } = await import('../../../scripts/mock-llm')
            const requests: Record<string, unknown>[] = []
            const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
              Object.assign(
                async (input: RequestInfo | URL, init?: RequestInit) => {
                  const req = input instanceof Request ? input : new Request(input, init)
                  requests.push((await req.clone().json()) as Record<string, unknown>)
                  return mockLlmFetch(req)
                },
                { preconnect: fetch.preconnect },
              ),
            )
            try {
              for (const text of ['VOICEPLEASE', '发语音']) {
                start = calls.length
                await service.receive(account.id, {
                  update_id: ++seq,
                  message: {
                    message_id: seq,
                    chat: { id: 111, type: 'private' },
                    from: { id: 111, first_name: 'Owner' },
                    text,
                  },
                })
                await host.waitIdle(chat.id, 10000)
                await Bun.sleep(200)
                expect(audio(start).length).toBeGreaterThan(0)
              }
              expect(requests.some((request) => JSON.stringify(request.tools).includes('send_voice'))).toBe(true)
              db.update(schema.promptPresets)
                .set({ data: { ...prompt.data, samplers: { ...prompt.data.samplers, functionCalling: false } } })
                .where(eq(schema.promptPresets.id, prompt.id))
                .run()
              const before = requests.length
              start = calls.length
              await service.generate(binding, { mode: 'send', text: 'VOICEPLEASE', images: [] })
              await host.waitIdle(chat.id, 10000)
              await Bun.sleep(200)
              expect(requests.slice(before).every((request) => request.tools === undefined)).toBe(true)
              expect(audio(start)).toHaveLength(0)
            } finally {
              fetchMock.mockRestore()
            }
          }
          await service.runtime.stop(account.id)
        }
      } finally {
        synth.mockRestore()
        service.dispose()
      }
    })
  } finally {
    closeUserDatabase(owner.handle)
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
