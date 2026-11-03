import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('渠道拟人分条：双平台首次投递、修订、分页、取消与逐条记录', async () => {
  if (!process.env.BURST_CHANNEL_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, BURST_CHANNEL_CHILD: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'nobot-burst-'))
  process.env.DATA_DIR = directory
  const { channelAccountInput, channelBindingInput, apiPresetInput } = await import('@nobot/shared')
  const { eq } = await import('drizzle-orm')
  const { db, newId } = await import('../src/db/client')
  const { channelDeliveries, messages, channelBindings, chats } = await import('../src/db/schema')
  const { systemDatabase } = await import('../src/db/system-client')
  const { users } = await import('../src/db/system-schema')
  const { runAsUser, closeUserDatabase } = await import('../src/user-context')
  const registry = await import('../src/extensions/registry')
  const { createExtensionHost } = await import('../src/extensions/host')
  const { ChannelService } = await import('../src/extensions/builtin/channels/service')
  const { OneBotClient } = await import('../src/extensions/builtin/channels/adapters/onebot11/client')
  const { OneBotSendQueue } = await import('../src/extensions/builtin/channels/adapters/onebot11/transport')
  const { createCharacter } = await import('../src/services/characters')
  const { createChat, loadMessage } = await import('../src/services/chats')
  const owner = { id: 'burst-owner', handle: 'burst-owner', name: 'Owner', isAdmin: true }
  systemDatabase()
    .insert(users)
    .values({ ...owner, passwordHash: 'unused', createdAt: Date.now() })
    .run()
  try {
    await runAsUser(owner, async () => {
      await registry.ensureUserExtensions()
      const host = createExtensionHost(registry.emitServerEvent)
      const service = new ChannelService(host, () => ({}))
      const { createApiPreset } = await import('../src/services/connections')
      const { mockLlm } = await import('./helpers/mockLlm')
      const model = mockLlm()
      createApiPreset(apiPresetInput.parse({ name: 'Mock', baseUrl: model.url, model: 'mock' }))
      let sequence = 100
      const calls: { method: string; body: Record<string, unknown> }[] = []
      service.runtime.fetch = async (url, init) => {
        const method = String(url).split('/').at(-1)!
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        calls.push({ method, body })
        return Response.json({
          ok: true,
          result:
            method === 'getMe'
              ? { id: 999, is_bot: true, username: 'burst_bot' }
              : method.startsWith('send')
                ? { message_id: ++sequence }
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
      const sleeps: number[] = []
      const fakeSleep = async (ms: number) => {
        sleeps.push(ms)
      }
      service.sleep = fakeSleep
      try {
        for (const provider of ['onebot11', 'telegram'] as const) {
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
                const call = JSON.parse(raw) as { action: string; params: Record<string, unknown>; echo: string }
                calls.push({ method: call.action, body: call.params })
                const data =
                  call.action === 'get_login_info'
                    ? { user_id: 999, nickname: 'QQ' }
                    : call.action === 'get_version_info'
                      ? { app_name: 'NapCat' }
                      : call.action === 'get_group_list' || call.action === 'get_friend_list'
                        ? []
                        : { message_id: ++sequence }
                queueMicrotask(() => client.transport.receive({ echo: call.echo, status: 'ok', retcode: 0, data }))
              },
            })
            await Bun.sleep(0)
          }
          let binding = {
            ...channelBindingInput.parse({
              accountId: account.id,
              scope: 'group',
              chat: '-100',
              chatId: chat.id,
              state: 'active',
              trigger: 'all',
              thread: provider === 'telegram' ? '42' : '',
              isolation: provider === 'telegram' ? 'per-topic' : 'shared',
              settings: { burst: 'lines', personaPrefix: false, controlsFooter: false },
            }),
            id: newId(),
            createdBy: owner.id,
            lastActivityAt: Date.now(),
            idleWarnedAt: null,
          }
          service.saveBinding(binding)
          // 触发消息由接收路径记录；此处直接设置以隔离自动生成和权限逻辑。
          const internals = service as unknown as { triggers: Map<string, number> }
          internals.triggers.set(binding.id, 77)
          const append = (text = '这是第一行内容\n这是第二行内容\n这是第三行内容') =>
            host.appendMessage(chat.id, { role: 'assistant', content: text })
          const delivery = (id: string) =>
            db.select().from(channelDeliveries).where(eq(channelDeliveries.messageId, id)).get()!
          const sends = () =>
            calls.filter((call) => call.method === (provider === 'telegram' ? 'sendMessage' : 'send_group_msg'))
          const reset = () => {
            calls.length = 0
            sleeps.length = 0
            service.sleep = fakeSleep
          }
          reset()
          const first = append()
          service.sleep = async (ms) => {
            expect(delivery(first.id).parts).toHaveLength(sleeps.length + 1)
            sleeps.push(ms)
          }
          await service.deliver(binding, first)
          expect(sends()).toHaveLength(3)
          expect(delivery(first.id).parts).toHaveLength(3)
          expect(sleeps).toHaveLength(2)
          expect(sleeps.every((ms) => ms >= 800 && ms <= 6000)).toBe(true)
          if (provider === 'onebot11') {
            const replies = sends().map(
              (call) => (call.body.message as { type: string }[]).filter((segment) => segment.type === 'reply').length,
            )
            expect(replies).toEqual([1, 0, 0])
          } else {
            expect(sends().map((call) => !!call.body.reply_markup)).toEqual([false, false, true])
            expect(
              calls
                .filter((call) => call.method === 'sendChatAction')
                .map((call) => [call.body.action, call.body.message_thread_id]),
            ).toEqual([
              ['typing', '42'],
              ['typing', '42'],
            ])
          }
          reset()
          db.update(messages)
            .set({ content: '这是编辑后的第一行\n这是编辑后的第二行' })
            .where(eq(messages.id, first.id))
            .run()
          await service.deliver(binding, loadMessage(first.id))
          expect(sleeps).toHaveLength(0)
          expect(
            provider === 'onebot11' ? sends().length : calls.filter((call) => call.method === 'editMessageText').length,
          ).toBe(1)

          reset()
          binding = { ...binding, settings: { ...binding.settings, burst: 'off' } }
          service.saveBinding(binding)
          await service.deliver(binding, append())
          expect(sends()).toHaveLength(1)
          expect(sleeps).toHaveLength(0)

          reset()
          binding = { ...binding, settings: { ...binding.settings, burst: 'lines', controlsFooter: true } }
          service.saveBinding(binding)
          const choice = append()
          db.update(messages)
            .set({ meta: { ...choice.meta, stage: { choices: [{ text: '选择这条路线' }] } } })
            .where(eq(messages.id, choice.id))
            .run()
          await service.deliver(binding, loadMessage(choice.id))
          expect(sends()).toHaveLength(3)
          if (provider === 'onebot11') {
            const texts = sends().map(
              (call) =>
                (call.body.message as { type: string; data: { text?: string } }[]).find(
                  (segment) => segment.type === 'text',
                )!.data.text!,
            )
            expect(texts.slice(0, 2).every((text) => !text.includes('1. ') && !text.includes('/regen'))).toBe(true)
            expect(texts[2]).toContain('1. 选择这条路线')
            expect(texts[2]).toContain('/regen')
          } else {
            expect(JSON.stringify(sends()[2]!.body.reply_markup)).toContain('选择这条路线')
          }

          // 发送期间扩展往 meta 里写东西（翻译、语音缓存）不算改动，照常发完
          reset()
          const annotated = append()
          service.sleep = async (ms) => {
            sleeps.push(ms)
            db.update(messages)
              .set({ meta: { ...annotated.meta, reasoning: `note ${sleeps.length}` } })
              .where(eq(messages.id, annotated.id))
              .run()
          }
          await service.deliver(binding, annotated)
          expect(sends()).toHaveLength(3)
          expect(delivery(annotated.id).parts).toHaveLength(3)
          for (const cancel of ['edit', 'delete', 'inactive', 'branch'] as const) {
            reset()
            const message = append()
            service.sleep = async (ms) => {
              sleeps.push(ms)
              expect(delivery(message.id).parts).toHaveLength(1)
              if (cancel === 'edit')
                db.update(messages).set({ content: '已经改变' }).where(eq(messages.id, message.id)).run()
              if (cancel === 'delete') {
                db.delete(messages).where(eq(messages.id, message.id)).run()
                db.update(chats).set({ activeLeafId: message.parentId }).where(eq(chats.id, chat.id)).run()
              }
              // 重新生成 / 切换备选：消息还在，但已不在当前分支上
              if (cancel === 'branch')
                db.update(chats).set({ activeLeafId: message.parentId }).where(eq(chats.id, chat.id)).run()
              if (cancel === 'inactive')
                db.update(channelBindings).set({ state: 'paused' }).where(eq(channelBindings.id, binding.id)).run()
            }
            await service.deliver(binding, message)
            expect(sends()).toHaveLength(1)
            expect(delivery(message.id).parts).toHaveLength(1)
            service.saveBinding(binding)
            // 切回原分支，后面追加的消息才不会被当成这条的重新生成
            if (cancel === 'branch')
              db.update(chats).set({ activeLeafId: message.id }).where(eq(chats.id, chat.id)).run()
          }
          if (provider === 'telegram') {
            reset()
            const otherChat = createChat({ characterId: character.id })
            const otherBinding = {
              ...binding,
              id: newId(),
              chatId: otherChat.id,
              thread: '43',
              settings: { ...binding.settings, burst: 'off' as const },
            }
            service.saveBinding(otherBinding)
            const otherMessage = host.appendMessage(otherChat.id, { role: 'assistant', content: '另一个话题即时回复' })
            let release = () => {}
            let reached = () => {}
            const waiting = new Promise<void>((resolve) => {
              reached = resolve
            })
            const gate = new Promise<void>((resolve) => {
              release = resolve
            })
            service.sleep = async () => {
              reached()
              await gate
            }
            const pending = service.deliver(binding, append())
            await waiting
            let timeout: ReturnType<typeof setTimeout> | undefined
            try {
              const independent = service.deliver(otherBinding, otherMessage).then(() => true)
              const completed = await Promise.race([
                independent,
                new Promise<boolean>((resolve) => {
                  timeout = setTimeout(() => resolve(false), 3000)
                }),
              ])
              expect(completed).toBe(true)
              expect(delivery(otherMessage.id).parts).toHaveLength(1)
            } finally {
              clearTimeout(timeout)
              release()
              await pending
            }
            db.delete(channelBindings).where(eq(channelBindings.id, otherBinding.id)).run()
            reset()
            let starts = 0
            const subscribe = host.subscribe.bind(host)
            const listener = spyOn(host, 'subscribe').mockImplementation((job, callback) =>
              subscribe(job, (event) => {
                callback(event)
                if (event.type === 'start') {
                  starts++
                  expect((service as unknown as { streams: Map<string, unknown> }).streams.size).toBe(0)
                }
              }),
            )
            try {
              model.setScript(() => ({
                text: '生成后的第一行内容\n生成后的第二行内容\n生成后的第三行内容',
                delayMs: 1,
              }))
              await service.generate(binding, { mode: 'send', text: 'Hello', images: [] })
              await host.waitIdle(chat.id, 5000)
              const generated = host.getChatInfo(chat.id).messages.at(-1)!
              const deadline = Date.now() + 5000
              while (delivery(generated.id)?.parts.length !== 3 && Date.now() < deadline) await Bun.sleep(10)
              expect(starts).toBe(1)
              expect(delivery(generated.id).parts).toHaveLength(3)
              expect(sends()).toHaveLength(3)
              expect(calls.some((call) => call.method === 'editMessageText')).toBe(false)
            } finally {
              listener.mockRestore()
            }
          }
          if (client instanceof OneBotClient) {
            reset()
            binding = { ...binding, settings: { ...binding.settings, maxMessageLength: 100, controlsFooter: false } }
            service.saveBinding(binding)
            await service.deliver(binding, append(`${'字'.repeat(210)}\n这是第二条内容`))
            expect(sends()).toHaveLength(4)
            expect(sleeps).toHaveLength(1)
            expect(delivery(host.getChatInfo(chat.id).messages.at(-1)!.id).parts).toHaveLength(4)
          }
        }
      } finally {
        service.dispose()
        model.stop()
      }
    })
  } finally {
    closeUserDatabase(owner.handle)
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
