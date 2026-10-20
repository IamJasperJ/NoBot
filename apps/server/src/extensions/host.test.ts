import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CharacterDTO, ChatDTO, MessageDTO, PromptPresetDTO } from '@nobot/shared'
import type { ServerEvent } from './types'

// 环境和数据库都是单例，子进程保证加载顺序验证不受其他测试影响。
test('扩展宿主：消息、静默请求、内置路由、动态工具及保存回调', async () => {
  if (!process.env.EXT2_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', 'apps/server/src/extensions/host.test.ts'], {
      env: { ...process.env, EXT2_TEST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timeout = setTimeout(() => child.kill(), 20000)
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, `${out}\n${err}`).toBe(0)
    } finally {
      clearTimeout(timeout)
    }
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'nobot-ext2-'))
  process.env.DATA_DIR = directory
  let sqlite: typeof import('../db/client').sqlite | undefined
  let server: ReturnType<typeof Bun.serve> | undefined
  let restoreFetch: (() => void) | undefined
  try {
    // 先加载宿主，再加载注册表，覆盖循环依赖的另一种入口顺序。
    const { createExtensionHost } = await import('./host')
    await (await import('../bootstrap')).bootstrap()
    sqlite = (await import('../db/client')).sqlite
    const { app } = await import('../app')
    const registry = await import('./registry')
    const { availableTools, runTool } = await import('../tools')
    const { assemble, loadGenerationContext, toHistory } = await import('../services/context')
    const { getChatRow, loadPath } = await import('../services/chats')
    const { listLogs, getLog } = await import('../services/logs')
    const events: ServerEvent[] = []
    const host = createExtensionHost((event) => {
      events.push(event)
      registry.emitServerEvent(event)
    })
    async function json<T>(path: string, data?: unknown, method = 'POST'): Promise<T> {
      const response = await app.request(`/api${path}`, {
        method,
        ...(data === undefined
          ? {}
          : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(data),
            }),
      })
      const body: unknown = await response.json()
      expect(response.status, JSON.stringify(body)).toBe(200)
      return body as T
    }
    const sharp = (await import('sharp')).default
    const bytes = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#fff' } })
      .png()
      .toBuffer()
    const attachment = await host.saveImage(bytes)
    expect(attachment).toMatchObject({ width: 4, height: 3 })
    expect(await Bun.file(join(directory, 'users/test/assets', 'attachments', `${attachment.id}.webp`)).exists()).toBe(
      true,
    )
    const actor = await json<CharacterDTO>('/characters', {
      name: '画师',
      description: '角色设定',
      personality: '温柔',
      scenario: '森林',
    })
    expect(host.getCharacter(actor.id).extensions).toEqual({})
    expect(host.updateCharacterExtensions(actor.id, { one: 1 }).extensions).toEqual({ one: 1 })
    expect(host.updateCharacterExtensions(actor.id, { two: 2 }).extensions).toEqual({ one: 1, two: 2 })
    expect(await host.readAvatar('character', actor.id)).toBeNull()
    const { setCharacterAvatar } = await import('../services/characters')
    await setCharacterAvatar(actor.id, bytes)
    expect(await host.readAvatar('character', actor.id)).toEqual(new Uint8Array(bytes))
    const persona = await json<{ id: string }>('/personas', { name: '人设', description: '' })
    expect(await host.readAvatar('persona', persona.id)).toBeNull()
    const form = new FormData()
    form.set('file', new File([bytes], '头像.png'))
    expect((await app.request(`/api/personas/${persona.id}/avatar`, { method: 'POST', body: form })).status).toBe(200)
    expect(await host.readAvatar('persona', persona.id)).toEqual(new Uint8Array(bytes))
    const chat = await json<ChatDTO>('/chats', { characterId: actor.id })
    const first = host.appendMessage(chat.id, {
      role: 'assistant',
      content: '',
      meta: { name: '画师', imageGen: { mode: 'last', status: 'pending' } },
    })
    expect(first.parentId).toBe(chat.activeLeafId)
    expect(getChatRow(chat.id).activeLeafId).toBe(first.id)
    expect(getChatRow(chat.id).updatedAt).toBeGreaterThanOrEqual(chat.updatedAt)
    const image = { id: 'fixture-image', url: '/image.webp', width: 512, height: 512 }
    const updated = host.updateMessageMeta(first.id, {
      images: [image],
      imageGen: { mode: 'last', status: 'done', prompt: '月光森林' },
    })
    expect(updated.meta.name).toBe('画师')
    expect(updated.meta.images).toEqual([image])
    expect(events.map((e) => e.type)).toEqual(['message:saved', 'message:updated'])
    host.updateMessageMeta(first.id, { images: [] })
    expect(host.getChatInfo(chat.id, 1)).toMatchObject({
      chat: { id: chat.id },
      characters: [
        {
          id: actor.id,
          name: '画师',
          description: '角色设定',
          muted: false,
          extensions: { one: 1, two: 2 },
          avatarUrl: expect.stringContaining(actor.id),
        },
      ],
      persona: { name: '旅人' },
      messages: [{ id: first.id, meta: { images: [] } }],
    })
    expect(host.getChatInfo(chat.id, 0).messages).toEqual([])
    await json(`/chats/${chat.id}`, { personaId: persona.id }, 'PATCH')
    expect(host.getChatInfo(chat.id).persona.avatarUrl).toContain(persona.id)
    await json(`/chats/${chat.id}`, { personaId: null }, 'PATCH')
    expect(() => host.appendMessage('missing', { role: 'user', content: '失败' })).toThrow()
    expect(() => host.updateMessageMeta('missing', {})).toThrow()
    await expect(host.quietPrompt({ chatId: chat.id, instruction: '无连接' })).rejects.toThrow()

    const ctx = loadGenerationContext(chat.id, { requireConnection: false })
    expect(toHistory(ctx, first.id).at(-1)).toMatchObject({ content: '(Sent an image: 月光森林)' })
    host.updateMessageMeta(first.id, { images: [image] })
    expect(toHistory(ctx, first.id).at(-1)?.images).toBeUndefined()
    host.updateMessageMeta(first.id, { imageGen: { mode: 'last', status: 'done', caption: '森林里的月光' } })
    expect(toHistory(ctx, first.id).at(-1)?.content).toBe('森林里的月光')
    host.updateMessageMeta(first.id, { imageGen: { mode: 'last', status: 'done', hidden: true } })
    expect(toHistory(ctx, first.id).some((m) => m.id === first.id)).toBe(false)
    host.updateMessageMeta(first.id, { images: [image, { ...image, id: 'second', url: '/second.webp' }] })
    const switched = await json<MessageDTO>(`/messages/${first.id}/meta`, { imageIndex: 0 }, 'PATCH')
    expect(switched.meta).toMatchObject({
      imageIndex: 0,
      imageGen: { hidden: true },
      images: [image, { ...image, id: 'second', url: '/second.webp' }],
    })
    for (const input of [
      { imageIndex: -1 },
      { imageIndex: 2 },
      { imageIndex: 0.5 },
      { imageIndex: 0, images: [] },
      {},
    ]) {
      expect(
        (
          await app.request(`/api/messages/${first.id}/meta`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
          })
        ).status,
      ).toBe(400)
    }
    expect(
      (
        await app.request('/api/messages/missing/meta', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: '{"imageIndex":0}',
        })
      ).status,
    ).toBe(404)
    const pending = host.appendMessage(chat.id, {
      role: 'assistant',
      content: '',
      meta: { imageGen: { mode: 'last', status: 'pending' } },
    })
    expect(toHistory(ctx, pending.id).some((m) => m.id === pending.id)).toBe(false)
    host.updateMessageMeta(pending.id, { imageGen: { mode: 'last', status: 'error' } })
    expect(toHistory(ctx, pending.id).some((m) => m.id === pending.id)).toBe(false)
    host.updateMessageMeta(pending.id, { images: [image] })
    expect(toHistory(ctx, pending.id).at(-1)?.content).toBe('(Sent an image)')
    const tool = host.appendMessage(chat.id, { role: 'tool', content: '工具结果', meta: { images: [image] } })
    expect(toHistory(ctx, tool.id).at(-1)).toMatchObject({ role: 'tool', content: '工具结果' })
    expect(toHistory(ctx, tool.id).at(-1)?.images).toBeUndefined()
    // 图片还在生成（或失败）的 tool 消息也必须留在历史里，否则 tool_calls 失去配对，模型会反复调用工具
    const pendingTool = host.appendMessage(chat.id, {
      role: 'tool',
      content: '图片正在生成',
      meta: { imageGen: { mode: 'tool', status: 'pending' } },
    })
    expect(toHistory(ctx, pendingTool.id).at(-1)).toMatchObject({ role: 'tool', content: '图片正在生成' })
    host.updateMessageMeta(pendingTool.id, { imageGen: { mode: 'tool', status: 'pending', hidden: true } })
    expect(toHistory(ctx, pendingTool.id).at(-1)).toMatchObject({ role: 'tool', content: '图片正在生成' })
    const user = host.appendMessage(chat.id, { role: 'user', content: '历史消息', meta: { images: [image] } })
    expect(toHistory(ctx, user.id).at(-1)?.images).toEqual([image.id])
    host.updateMessageMeta(user.id, { imageGen: { mode: 'last', status: 'done', hidden: true, caption: '用户图片' } })
    expect(toHistory(ctx, user.id).at(-1)?.content).toBe('历史消息')
    // 假附件只用于历史映射断言，真实请求前移除，避免绕过附件校验。
    host.updateMessageMeta(user.id, { images: [] })
    expect(
      assemble(ctx, { type: 'normal', speakerId: actor.id, leafId: null, toolsEnabled: false }).messages.some((m) =>
        m.content.includes('历史消息'),
      ),
    ).toBe(false)

    const requests: Record<string, unknown>[] = []
    let fail = false
    let toolMode = false
    const respond = async (request: Request) => {
      const body = (await request.json()) as Record<string, unknown>
      requests.push(body)
      if (fail) return Response.json({ error: { message: '模拟失败' } }, { status: 500 })
      const messages = body.messages as { role: string }[]
      const callTool = toolMode && !messages.some((m) => m.role === 'tool')
      return Response.json({
        choices: [
          {
            message: callTool
              ? {
                  content: '',
                  tool_calls: [{ id: 'call-ext2', type: 'function', function: { name: 'ext2_tool', arguments: '{}' } }],
                }
              : { content: '<think>不要返回思考</think>月光下的森林', reasoning_content: '私有思考' },
            finish_reason: callTool ? 'tool_calls' : 'stop',
          },
        ],
      })
    }
    // 沙箱不能监听端口时，可显式选择 fetch 模拟，保持后续数据库与生成流程验证。
    if (process.env.EXT2_FETCH_MOCK) {
      const mocked = spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            init?.signal?.throwIfAborted()
            const request = new Request(String(input), { method: 'POST', body: String(init?.body) })
            return respond(request)
          },
          { preconnect: fetch.preconnect },
        ),
      )
      restoreFetch = () => mocked.mockRestore()
    } else {
      server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: respond })
    }
    await json('/connections', {
      name: '测试',
      baseUrl: `http://127.0.0.1:${server?.port ?? 12345}/v1`,
      model: 'mock-ext2',
      apiKey: 'ext2-secret-key',
    })
    expect(await host.quietPrompt({ chatId: chat.id, instruction: '写提示词', maxTokens: 123 })).toBe('月光下的森林')
    const body = requests.at(-1)!
    expect(body.stream).toBe(false)
    expect(body.max_tokens).toBe(123)
    expect((body.messages as { role: string; content: string }[]).at(-1)).toEqual({
      role: 'system',
      content: '写提示词',
    })
    expect(JSON.stringify(body.messages)).toContain('历史消息')
    expect(
      await host.quietPrompt({ chatId: chat.id, instruction: '不要历史', role: 'user', includeHistory: false }),
    ).toBe('月光下的森林')
    expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain('历史消息')
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain('角色设定')
    expect(getChatRow(chat.id).activeLeafId).toBe(user.id)
    expect(listLogs({ chatId: chat.id }).some((log) => log.kind === 'extension' && log.model === 'mock-ext2')).toBe(
      true,
    )
    expect(JSON.stringify(getLog(listLogs({ chatId: chat.id })[0]!.id))).not.toContain('ext2-secret-key')
    fail = true
    await expect(host.quietPrompt({ chatId: chat.id, instruction: '失败请求' })).rejects.toThrow('模拟失败')
    expect(listLogs({ chatId: chat.id }).some((log) => log.kind === 'extension' && log.status === 'error')).toBe(true)
    fail = false
    const controller = new AbortController()
    controller.abort()
    await expect(
      host.quietPrompt({ chatId: chat.id, instruction: '中止请求', signal: controller.signal }),
    ).rejects.toThrow()

    const extensionEvents: ServerEvent[] = []
    registry.registerBuiltinExtension({
      id: 'ext2-fixture',
      name: '平台测试',
      description: '',
      version: '1',
      defaultSettings: { tools: false },
      routes(app, ctx) {
        app.get('/info', (c) => c.json(ctx.host.getChatInfo(c.req.query('chatId') ?? '', 1)))
      },
      hooks: {
        onEvent(event) {
          extensionEvents.push(event)
        },
      },
      tools: (ctx) =>
        ctx.settings.tools
          ? [
              {
                name: 'ext2_tool',
                description: '测试工具',
                parameters: {},
                run(_args, toolCtx) {
                  expect(toolCtx.extension?.chatId).toBe(toolCtx.chatId)
                  expect(toolCtx.extension?.settings.tools).toBe(true)
                  return {
                    content: '保存图片',
                    meta: { images: [image], imageGen: { status: 'pending', mode: 'last' } },
                    onSaved(id) {
                      toolCtx.extension?.host.updateMessageMeta(id, { imageGen: { status: 'done', mode: 'last' } })
                      throw new Error('回调失败也应继续')
                    },
                  }
                },
              },
            ]
          : [],
    })
    expect((await app.request(`/api/ext/ext2-fixture/info?chatId=${chat.id}`)).status).toBe(200)
    expect(availableTools().some(({ tool }) => tool.name === 'ext2_tool')).toBe(false)
    expect(registry.updateExtension('ext2-fixture', { settings: { tools: true } }).provides.tools).toEqual([
      'ext2_tool',
    ])
    expect(availableTools().some(({ tool }) => tool.name === 'ext2_tool')).toBe(true)
    const direct = await runTool('ext2_tool', '{}', { chatId: chat.id, vars: {} })
    expect(direct.meta?.images).toEqual([image])
    const emptyChat = await json<ChatDTO>('/chats', { characterId: actor.id })
    const preset = (await json<PromptPresetDTO[]>('/presets', undefined, 'GET'))[0]!
    await json(
      `/presets/${preset.id}`,
      { data: { ...preset.data, samplers: { ...preset.data.samplers, functionCalling: true, stream: false } } },
      'PATCH',
    )
    toolMode = true
    const { startGeneration, isGenerating } = await import('../services/generation')
    const job = startGeneration(emptyChat.id, { mode: 'send', text: '触发工具', images: [] })
    expect(host.isGenerating(emptyChat.id)).toBe(true)
    expect(() => host.appendMessage(emptyChat.id, { role: 'assistant', content: '' })).toThrow(
      '会话正在生成，请稍后再试',
    )
    const { subscribe } = await import('../services/generation')
    await new Promise<void>((resolve) => {
      subscribe(job, (event) => {
        if (event.type === 'complete') resolve()
      })
    })
    expect(isGenerating(emptyChat.id)).toBe(false)
    const saved = loadPath(getChatRow(emptyChat.id).activeLeafId).find((m) => m.role === 'tool') as MessageDTO
    expect(saved.meta).toMatchObject({
      images: [image],
      imageGen: { status: 'done' },
      toolName: 'ext2_tool',
      toolCallId: 'call-ext2',
    })
    expect(extensionEvents.some((e) => e.type === 'message:updated' && e.message.id === saved.id)).toBe(true)
    expect(listLogs({}).some((log) => log.summary.includes('回调失败也应继续'))).toBe(true)
    registry.updateExtension('ext2-fixture', { enabled: false })
    expect((await app.request(`/api/ext/ext2-fixture/info?chatId=${chat.id}`)).status).toBe(404)
    expect(availableTools().some(({ tool }) => tool.name === 'ext2_tool')).toBe(false)
    const ordered: string[] = []
    for (let i = 0; i < 22; i++) ordered.push(host.appendMessage(chat.id, { role: 'user', content: `消息 ${i}` }).id)
    expect(host.getChatInfo(chat.id).messages.map((message) => message.id)).toEqual(ordered.slice(-20))
    host.log({ kind: 'image', status: 'ok', summary: '图片接口日志' })
    expect(listLogs({}).some((log) => log.kind === 'image')).toBe(true)
  } finally {
    restoreFetch?.()
    await server?.stop(true)
    sqlite?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 25000)
