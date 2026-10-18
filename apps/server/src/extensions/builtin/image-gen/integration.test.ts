import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackgroundDTO, CharacterDTO, ChatDTO, MessageDTO, PromptPresetDTO } from '@ai-parter/shared'

// 数据库和环境变量都是模块单例，用独立进程隔离其他测试的 DATA_DIR。
test('图片扩展：路由、占位、重试、背景、ComfyUI、工具和日志', async () => {
  if (!process.env.IMG3_TEST_CHILD) {
    const child = Bun.spawn(
      [process.execPath, 'test', 'apps/server/src/extensions/builtin/image-gen/integration.test.ts'],
      { env: { ...process.env, IMG3_TEST_CHILD: '1' }, stdout: 'pipe', stderr: 'pipe' },
    )
    const timeout = setTimeout(() => child.kill(), 25000)
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
  const directory = await mkdtemp(join(tmpdir(), 'ai-parter-img3-'))
  process.env.DATA_DIR = directory
  let sqlite: typeof import('../../../db/client').sqlite | undefined
  let server: ReturnType<typeof Bun.serve> | undefined
  let restore: (() => void) | undefined
  try {
    await (await import('../../../bootstrap')).bootstrap()
    sqlite = (await import('../../../db/client')).sqlite
    const { app } = await import('../../../app')
    const { updateExtension } = await import('../../registry')
    const { loadMessage, getChatRow } = await import('../../../services/chats')
    const { listLogs, getLog } = await import('../../../services/logs')
    const { listBackgrounds } = await import('../../../services/backgrounds')
    const { setAppSettings } = await import('../../../services/settings')
    const { availableTools, runTool } = await import('../../../tools')
    const { createExtensionHost } = await import('../../host')
    const host = createExtensionHost(() => {})
    const png = await (await import('sharp'))
      .default({ create: { width: 64, height: 64, channels: 3, background: '#abc' } })
      .png()
      .toBuffer()
    let imageRunning = 0
    let imagePeak = 0
    let fail = false
    let delay = 30
    const bodies: Record<string, unknown>[] = []
    let historyCalls = 0
    let capabilityCalls = 0
    const remoteHeaders: Headers[] = []
    const remoteRequests: { url: string; authorization: string | null }[] = []
    let textGate: Promise<void> | undefined
    let promptFail = false
    const chatRequests: Record<string, unknown>[] = []
    const respond = async (request: Request) => {
      remoteHeaders.push(new Headers(request.headers))
      const url = new URL(request.url)
      remoteRequests.push({ url: request.url, authorization: request.headers.get('authorization') })
      if (url.pathname.endsWith('/models'))
        return Response.json({ data: [{ id: 'chat-model' }, { id: 'flux-dev' }, { id: 'gpt-image-1' }] })
      if (url.pathname === '/system_stats') return Response.json({ system: { os: 'mock' } })
      if (url.pathname.endsWith('/images/generations')) {
        const body = (await request.json()) as Record<string, unknown>
        bodies.push(body)
        imageRunning++
        imagePeak = Math.max(imagePeak, imageRunning)
        try {
          await Bun.sleep(delay)
          if (fail || String(body.prompt).includes('FAIL') || body.model === 'unsupported-model')
            return Response.json({ error: { message: '模拟图片失败' } }, { status: 500 })
          if (body.model === 'download') return Response.json({ data: [{ url: `${url.origin}/view` }] })
          return Response.json({ data: [{ b64_json: png.toString('base64') }] })
        } finally {
          imageRunning--
        }
      }
      if (url.pathname.endsWith('/chat/completions')) {
        const body = (await request.json()) as Record<string, unknown>
        chatRequests.push(body)
        if (textGate) await textGate
        if (promptFail) return Response.json({ error: { message: '模拟写词失败' } }, { status: 500 })
        return Response.json({
          choices: [{ message: { content: '<think>隐藏</think>Prompt: "1girl, blue hair"' }, finish_reason: 'stop' }],
        })
      }
      if (url.pathname === '/prompt') {
        bodies.push((await request.json()) as Record<string, unknown>)
        return Response.json({ prompt_id: 'mock' })
      }
      if (url.pathname === '/history/mock') {
        historyCalls++
        return Response.json(
          historyCalls < 2
            ? {}
            : { mock: { outputs: { '9': { images: [{ filename: 'mock.png', subfolder: '', type: 'output' }] } } } },
        )
      }
      if (url.pathname === '/view') return new Response(png)
      if (url.pathname === '/object_info') {
        capabilityCalls++
        return Response.json({
          CheckpointLoaderSimple: { input: { required: { ckpt_name: [['mock_a', 'mock_b']] } } },
          UNETLoader: { input: { required: { unet_name: [['flux_dev.safetensors']] } } },
          UnetLoaderGGUF: { input: { required: { unet_name: [['flux.gguf']] } } },
          KSampler: {
            input: { required: { sampler_name: [['euler', 'euler_ancestral']], scheduler: [['normal', 'karras']] } },
          },
          VAELoader: { input: { required: { vae_name: [['ae.safetensors']] } } },
        })
      }
      return new Response('没有接口', { status: 404 })
    }
    // 端口受限的执行环境可使用同一个处理器替换全局 fetch。
    if (process.env.IMG3_FETCH_MOCK) {
      const mocked = spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => respond(new Request(String(input), init)),
          { preconnect: fetch.preconnect },
        ),
      )
      restore = () => mocked.mockRestore()
    } else {
      server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: respond })
    }
    const base = `http://127.0.0.1:${server?.port ?? 12345}`
    async function json<T>(path: string, data?: unknown, method = 'POST'): Promise<T> {
      const response = await app.request(`/api${path}`, {
        method,
        ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
      })
      const body = await response.json()
      expect(response.status, JSON.stringify(body)).toBe(200)
      return body as T
    }
    const actor = await json<CharacterDTO>('/characters', {
      name: '画师',
      description: '蓝色头发',
      firstMes: '欢迎来到森林',
    })
    const chat = await json<ChatDTO>('/chats', { characterId: actor.id })
    await json('/connections', { name: '写词模型', baseUrl: `${base}/v1`, model: 'chat-model', apiKey: 'chat-secret' })
    let settings: Record<string, unknown> = {
      openaiBaseUrl: `${base}/v1`,
      openaiApiKey: 'img3-secret-key',
      async: false,
    }
    const configure = (patch: Record<string, unknown>) => {
      settings = { ...settings, ...patch }
      updateExtension('image-gen', { settings })
    }
    configure({})
    const result = await json<{ message: MessageDTO }>('/ext/image-gen/generate', {
      chatId: chat.id,
      mode: 'character',
    })
    expect(result.message.meta).toMatchObject({
      name: '画师',
      imageGen: {
        status: 'done',
        mode: 'character',
        prompt: 'best quality, masterpiece, highly detailed, 1girl, blue hair',
      },
    })
    expect(result.message.speakerId).toBe(actor.id)
    expect(result.message.meta.images?.[0]?.width).toBe(64)
    // 默认原样发送设置的分辨率，不按模型名贴合
    expect(bodies[0]).toMatchObject({ n: 1, size: '832x1216' })
    expect(bodies[0]).not.toHaveProperty('negative_prompt')
    async function wait(id: string, status = 'done') {
      for (let i = 0; i < 200; i++) {
        const message = loadMessage(id)
        if (message.meta.imageGen?.status === status) return message
        await Bun.sleep(10)
      }
      throw new Error(`等待图片状态 ${status} 超时`)
    }
    configure({ async: true, maxConcurrent: 2 })
    imagePeak = 0
    delay = 100
    const parallel = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        json<{ message: MessageDTO }>('/ext/image-gen/generate', { chatId: chat.id, mode: 'free', input: `!cat ${i}` }),
      ),
    )
    for (const { message } of parallel) expect(message.meta.imageGen?.status).toBe('pending')
    expect(new Set(parallel.map(({ message }) => message.id)).size).toBe(3)
    for (const { message } of parallel) {
      const done = await wait(message.id)
      expect(done.meta.images).toHaveLength(1)
      expect(done.meta.imageGen?.status).toBe('done')
    }
    expect(imagePeak).toBe(2)
    configure({ async: false })
    const synchronous = await Promise.all(
      Array.from({ length: 2 }, () =>
        json<{ message: MessageDTO }>('/ext/image-gen/generate', { chatId: chat.id, mode: 'free', input: '!cat' }),
      ),
    )
    for (const { message } of synchronous) {
      expect(message.meta.imageGen?.status).toBe('done')
      expect(message.meta.images).toHaveLength(1)
    }
    expect(
      synchronous[1]!.message.parentId === synchronous[0]!.message.id ||
        synchronous[0]!.message.parentId === synchronous[1]!.message.id,
    ).toBe(true)
    configure({ async: true })
    const preset = (await json<PromptPresetDTO[]>('/presets', undefined, 'GET'))[0]!
    await json(
      `/presets/${preset.id}`,
      {
        data: { ...preset.data, samplers: { ...preset.data.samplers, stream: false } },
      },
      'PATCH',
    )
    let finishText = () => {}
    textGate = new Promise<void>((resolve) => {
      finishText = resolve
    })
    const { startGeneration } = await import('../../../services/generation')
    startGeneration(chat.id, { mode: 'send', text: '先回复文字', images: [] })
    expect(host.isGenerating(chat.id)).toBe(true)
    expect(() => host.appendMessage(chat.id, { role: 'assistant', content: '' })).toThrow('会话正在生成')
    await expect(host.waitIdle(chat.id, 5)).rejects.toThrow('等待文本生成结束超时')
    let inserted = false
    const waitingImage = json<{ message: MessageDTO }>('/ext/image-gen/generate', {
      chatId: chat.id,
      mode: 'free',
      input: '!after text',
    }).then((value) => {
      inserted = true
      return value
    })
    await Bun.sleep(30)
    expect(inserted).toBe(false)
    const textLeaf = getChatRow(chat.id).activeLeafId
    finishText()
    const afterText = (await waitingImage).message
    textGate = undefined
    expect(afterText.parentId).toBe(textLeaf)
    expect(host.isGenerating(chat.id)).toBe(false)
    expect(loadMessage(afterText.parentId!).content).toContain('1girl')
    expect((await wait(afterText.id)).meta.images).toHaveLength(1)
    fail = true
    const failed = await json<{ message: MessageDTO }>('/ext/image-gen/generate', {
      chatId: chat.id,
      mode: 'scene',
    })
    const error = await wait(failed.message.id, 'error')
    expect(error.meta.imageGen?.error).toContain('HTTP 500')
    expect(error.meta.imageGen?.prompt).toBeTruthy()
    fail = false
    await json('/ext/image-gen/retry', { messageId: error.id })
    const duplicateRetry = await app.request('/api/ext/image-gen/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: error.id }),
    })
    expect(duplicateRetry.status).toBe(409)
    expect(await duplicateRetry.text()).toContain('这张图片正在重新生成')
    const retried = await wait(error.id)
    const firstId = retried.meta.images?.[0]?.id
    await json('/ext/image-gen/retry', { messageId: error.id })
    expect((await wait(error.id)).meta.images).toHaveLength(2)
    expect(loadMessage(error.id).meta.images?.[0]?.id).toBe(firstId)
    expect(loadMessage(error.id).meta.imageIndex).toBe(1)
    await json('/ext/image-gen/retry', { messageId: error.id, append: false })
    expect((await wait(error.id)).meta.images).toHaveLength(1)
    expect(loadMessage(error.id).meta.imageIndex).toBe(0)
    // IMGERR：成功→FAIL 失败格→改词重试，原图保留且不再调用写词模型。
    const beforeEditedRetry = chatRequests.length
    const failingRetry = await json<{ message: MessageDTO }>('/ext/image-gen/retry', {
      messageId: error.id,
      prompt: 'FAIL',
      negative: '失败负面词',
    })
    expect(failingRetry.message.meta).toMatchObject({ imageIndex: 1, imageGen: { status: 'pending', prompt: 'FAIL' } })
    await json(`/messages/${error.id}/meta`, { imageIndex: 0 }, 'PATCH')
    const failedAgain = await wait(error.id, 'error')
    expect(failedAgain.meta.imageIndex).toBe(1)
    expect(failedAgain.meta.images).toHaveLength(1)
    await json(`/messages/${error.id}/meta`, { imageIndex: 0 }, 'PATCH')
    await json(`/messages/${error.id}/meta`, { imageIndex: 1 }, 'PATCH')
    const invalidIndex = await app.request(`/api/messages/${error.id}/meta`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageIndex: 2 }),
    })
    expect(invalidIndex.status).toBe(400)
    await json('/ext/image-gen/retry', { messageId: error.id, prompt: 'fixed cat', negative: '' })
    const fixed = await wait(error.id)
    expect(fixed.meta.images).toHaveLength(2)
    expect(fixed.meta.imageIndex).toBe(1)
    expect(fixed.meta.imageGen).toMatchObject({ prompt: 'fixed cat', negative: '' })
    expect(fixed.meta.imageGen?.error).toBeUndefined()
    expect(chatRequests).toHaveLength(beforeEditedRetry)
    const doneIndex = await app.request(`/api/messages/${error.id}/meta`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageIndex: 2 }),
    })
    expect(doneIndex.status).toBe(400)
    await json('/ext/image-gen/retry', { messageId: error.id, prompt: 'FAIL' })
    await wait(error.id, 'error')
    const dismissed = await json<{ message: MessageDTO }>('/ext/image-gen/dismiss', { messageId: error.id })
    expect(dismissed.message.meta).toMatchObject({ imageIndex: 1, imageGen: { status: 'done' } })
    expect(dismissed.message.meta.imageGen?.error).toBeUndefined()
    expect(dismissed.message.meta.images).toHaveLength(2)
    // 用户反馈：模型不被支持导致失败，改好模型后点「重新生成」必须用新设置，而不是原任务冻结的旧模型
    configure({ openaiModel: 'unsupported-model', async: true })
    const wrongModel = await json<{ message: MessageDTO }>('/ext/image-gen/generate', {
      chatId: chat.id,
      mode: 'free',
      input: '!a fox',
    })
    await wait(wrongModel.message.id, 'error')
    configure({ openaiModel: 'gpt-image-1', async: false })
    await json('/ext/image-gen/retry', { messageId: wrongModel.message.id })
    const recovered = await wait(wrongModel.message.id)
    expect(recovered.meta.imageGen?.status).toBe('done')
    expect(bodies.at(-1)).toMatchObject({ model: 'gpt-image-1', prompt: expect.stringContaining('a fox') })
    // 默认不按模型名限制尺寸，重试沿用原画幅
    expect(bodies.at(-1)?.size).toBe('832x1216')
    configure({ async: true })
    const dismissDone = await app.request('/api/ext/image-gen/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: error.id }),
    })
    expect(dismissDone.status).toBe(409)
    const emptyFailure = await json<{ message: MessageDTO }>('/ext/image-gen/generate', {
      chatId: chat.id,
      mode: 'free',
      input: '!FAIL',
    })
    await wait(emptyFailure.message.id, 'error')
    const child = host.appendMessage(chat.id, { role: 'user', content: '失败后的子消息' })
    expect(getChatRow(chat.id).activeLeafId).toBe(child.id)
    expect(await json('/ext/image-gen/dismiss', { messageId: emptyFailure.message.id })).toEqual({ deleted: true })
    expect(getChatRow(chat.id).activeLeafId).toBe(emptyFailure.message.parentId)
    expect(() => loadMessage(emptyFailure.message.id)).toThrow()
    expect(() => loadMessage(child.id)).toThrow()
    const beforeBackground = getChatRow(chat.id).activeLeafId
    const bg = await json<{ background: BackgroundDTO; message: MessageDTO }>('/ext/image-gen/generate', {
      chatId: chat.id,
      mode: 'background',
    })
    expect(bg.background.source).toBe('generated')
    expect(bg.background.name).toBe('1girl, blue hair')
    expect(getChatRow(chat.id).backgroundId).toBe(bg.background.id)
    expect(bg.message.parentId).toBe(beforeBackground)
    expect(getChatRow(chat.id).activeLeafId).toBe(bg.message.id)
    expect(bg.message.meta.images).toHaveLength(1)
    expect(bg.message.meta.imageGen).toMatchObject({ mode: 'background', status: 'done' })
    await json('/ext/image-gen/to-background', { messageId: error.id })
    expect(listBackgrounds()).toHaveLength(2)
    // 起名请求不带对话历史，输出语言必须跟随界面设置。
    for (const [language, expected] of [
      ['en', 'English'],
      ['zh', 'Chinese'],
    ] as const) {
      setAppSettings({ language })
      await json('/ext/image-gen/to-background', { messageId: error.id })
      const request = chatRequests.at(-1) as { messages: { content: string }[] }
      expect(request.messages.at(-1)?.content).toContain(`Write in ${expected}.`)
      expect(request.messages.at(-1)?.content).toContain('Output only JSON:')
    }
    const testResult = await json<{ image: { width: number }; durationMs: number }>('/ext/image-gen/test', {})
    expect(testResult.image.width).toBe(64)
    expect(testResult.durationMs).toBeGreaterThanOrEqual(0)
    configure({ source: 'comfy', comfyUrl: base, comfyCheckpoint: 'mock_a', async: false })
    expect(
      (await json<{ options: { value: string; label: string }[] }>('/ext/image-gen/comfy/models', {})).options,
    ).toContainEqual({ value: 'mock_a', label: 'mock a' })
    expect(
      (
        await json<{ message: MessageDTO }>('/ext/image-gen/generate', {
          chatId: chat.id,
          mode: 'free',
          input: '!cat',
        })
      ).message.meta.images,
    ).toHaveLength(1)
    expect(historyCalls).toBe(2)
    expect(availableTools().some(({ tool }) => tool.name === 'generate_image')).toBe(false)
    configure({ source: 'openai', toolEnabled: true, openaiExtra: '{"quality":"high", "negative_prompt":"custom"}' })
    expect(availableTools().some(({ tool }) => tool.name === 'generate_image')).toBe(true)
    const tool = await runTool('generate_image', '{"prompt":"cat","orientation":"square"}', {
      chatId: chat.id,
      vars: {},
    })
    expect(tool.meta?.imageGen).toMatchObject({ status: 'done', mode: 'tool' })
    // 方图：宽高相等（不再按模型名强制成 1024×1024）
    expect(tool.meta?.imageGen?.width).toBe(tool.meta?.imageGen?.height)
    expect(tool.meta?.images).toHaveLength(1)
    expect(bodies.at(-1)).toMatchObject({ quality: 'high', negative_prompt: 'custom', size: '832x832' })
    configure({ async: true })
    const asyncTool = await runTool('generate_image', '{"prompt":"cat"}', { chatId: chat.id, vars: {} })
    expect(asyncTool.meta?.imageGen?.status).toBe('pending')
    const savedTool = host.appendMessage(chat.id, { role: 'tool', content: asyncTool.content, meta: asyncTool.meta })
    asyncTool.onSaved?.(savedTool.id)
    expect((await wait(savedTool.id)).meta.images).toHaveLength(1)
    configure({ async: false })
    expect(
      (await runTool('generate_image', '{"prompt":"scenery","as_background":true}', { chatId: chat.id, vars: {} }))
        .content,
    ).toBe('Image generated and set as the chat background.')
    configure({ openaiBaseUrl: '' })
    expect(
      (await runTool('generate_image', '{"prompt":"cat"}', { chatId: chat.id, vars: {} })).meta?.imageGen?.status,
    ).toBe('error')
    configure({ openaiBaseUrl: `${base}/v1`, openaiApiKey: 'img3-secret-key', openaiExtra: '{' })
    const leaf = getChatRow(chat.id).activeLeafId
    const invalid = await app.request('/api/ext/image-gen/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: chat.id, mode: 'free', input: '!cat' }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).toContain('额外参数不是合法的 JSON')
    expect(getChatRow(chat.id).activeLeafId).toBe(leaf)
    configure({ openaiExtra: '', openaiModel: 'download' })
    expect((await json<{ image: { width: number } }>('/ext/image-gen/test', {})).image.width).toBe(64)
    configure({ openaiModel: 'gpt-image-1', async: false, promptWithHistory: false })
    const raw = host.appendMessage(chat.id, { role: 'user', content: '*静态画面*   blue eyes' })
    const beforeRaw = chatRequests.length
    const rawResult = await json<{ message: MessageDTO }>('/ext/image-gen/generate', {
      chatId: chat.id,
      mode: 'raw_last',
    })
    expect(rawResult.message.meta.imageGen?.prompt).toEndWith('静态画面 blue eyes')
    expect(chatRequests).toHaveLength(beforeRaw)
    for (const mode of ['face', 'user', 'last', 'message', 'free']) {
      const generated = await json<{ message: MessageDTO }>('/ext/image-gen/generate', {
        chatId: chat.id,
        mode,
        messageId: raw.id,
        input: '森林里的猫',
      })
      expect(generated.message.meta.imageGen).toMatchObject({ mode, status: 'done' })
    }
    expect(JSON.stringify(chatRequests.at(-1))).not.toContain('*静态画面*')
    configure({ async: true })
    promptFail = true
    const noPrompt = await json<{ message: MessageDTO }>('/ext/image-gen/generate', {
      chatId: chat.id,
      mode: 'free',
      input: '猫',
    })
    expect((await wait(noPrompt.message.id, 'error')).meta.imageGen?.prompt).toBeUndefined()
    promptFail = false
    await json('/ext/image-gen/retry', { messageId: noPrompt.message.id })
    expect((await wait(noPrompt.message.id)).meta.imageGen?.prompt).toContain('1girl')
    const actor2 = await json<CharacterDTO>('/characters', { name: '莱恩', description: '群聊第二角色专属外貌' })
    const group = await json<{ id: string }>('/groups', {
      name: '绘画小组',
      members: [{ characterId: actor.id, muted: true }, { characterId: actor2.id }],
    })
    const groupChat = await json<ChatDTO>('/chats', { groupId: group.id })
    configure({ async: false, promptWithHistory: true })
    const groupImage = await json<{ message: MessageDTO }>('/ext/image-gen/generate', {
      chatId: groupChat.id,
      mode: 'character',
    })
    expect(groupImage.message.speakerId).toBe(actor2.id)
    expect(JSON.stringify(chatRequests.at(-1))).toContain('群聊第二角色专属外貌')
    const selected = await json<{ message: MessageDTO }>('/ext/image-gen/generate', {
      chatId: groupChat.id,
      mode: 'face',
      characterId: actor.id,
    })
    expect(selected.message.speakerId).toBe(actor.id)
    const lastSpeaker = await json<{ message: MessageDTO }>('/ext/image-gen/generate', {
      chatId: groupChat.id,
      mode: 'character',
    })
    expect(lastSpeaker.message.speakerId).toBe(actor.id)
    const crossChat = await app.request('/api/ext/image-gen/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: groupChat.id, mode: 'message', messageId: raw.id }),
    })
    expect(crossChat.status).toBe(400)
    configure({ async: true, refineModelPrompts: false })
    const toolFailure = await runTool('generate_image', '{"prompt":"FAIL"}', { chatId: groupChat.id, vars: {} })
    const toolError = host.appendMessage(groupChat.id, {
      role: 'tool',
      content: toolFailure.content,
      meta: toolFailure.meta,
    })
    toolFailure.onSaved?.(toolError.id)
    expect((await wait(toolError.id, 'error')).meta.imageGen?.error).toContain('HTTP 500')
    await json('/ext/image-gen/retry', { messageId: toolError.id, prompt: 'fixed tool cat', negative: 'bad tool' })
    const fixedTool = await wait(toolError.id)
    expect(fixedTool.role).toBe('tool')
    expect(fixedTool.meta.images).toHaveLength(1)
    expect(fixedTool.meta.imageGen).toMatchObject({ prompt: 'fixed tool cat', negative: 'bad tool', status: 'done' })
    // IMG5：草稿发现、缓存、连接复用、预览快照与完整提示词。
    const connection = await json<{ id: string }>('/connections', {
      headers: { 'X-Connection': 'connection-secret', 'X-Override': 'saved' },
      name: '图片复用连接',
      baseUrl: `${base}/reused/v1`,
      apiKey: 'reused-secret',
      model: 'do-not-use-chat-model',
    })
    const modelOptions = await json<{ options: { value: string; label: string }[] }>(`/ext/image-gen/openai/models`, {
      settings: { openaiConnectionId: connection.id },
    })
    // 端点的全部模型都返回，不按名字限制；图片模型排在前面
    expect(modelOptions.options.map((item) => item.value)).toEqual(['flux-dev', 'gpt-image-1', 'chat-model'])
    expect(remoteRequests.at(-1)).toEqual({ url: `${base}/reused/v1/models`, authorization: 'Bearer reused-secret' })
    const all = await json<{ options: unknown[] }>(`/ext/image-gen/openai/models`, {
      settings: { openaiConnectionId: connection.id },
    })
    expect(all.options).toHaveLength(3)
    expect(remoteHeaders.at(-1)?.get('x-connection')).toBe('connection-secret')
    const connections = await json<{ options: { value: string }[] }>('/ext/image-gen/connections', {})
    expect(connections.options.some((item) => item.value === connection.id)).toBe(true)
    const promptModels = await json<{ options: unknown[] }>(`/ext/image-gen/prompt/models`, {
      settings: { promptConnectionId: connection.id },
    })
    expect(promptModels.options).toHaveLength(3)
    expect(remoteHeaders.at(-1)?.get('x-connection')).toBe('connection-secret')
    const comfyDraft = {
      source: 'comfy',
      comfyUrl: `${base}/`,
      comfyHeaders: '{"Authorization":"Bearer proxy-secret"}',
    }
    const capabilities = await json<{ models: { label: string }[] }>(`/ext/image-gen/comfy/capabilities`, {
      settings: comfyDraft,
    })
    expect(capabilities.models.map((item) => item.label)).toContain('UNet: flux_dev.safetensors')
    expect(capabilities.models.map((item) => item.label)).toContain('GGUF: flux.gguf')
    const count = capabilityCalls
    for (const name of ['models', 'samplers', 'schedulers', 'vaes']) {
      const options = await json<{ options: unknown[] }>(`/ext/image-gen/comfy/${name}`, { settings: comfyDraft })
      expect(options.options.length).toBeGreaterThan(0)
    }
    expect(capabilityCalls).toBe(count)
    expect(remoteRequests.at(-1)?.authorization).toBe('Bearer proxy-secret')
    const now = Date.now()
    const mockedClock = spyOn(Date, 'now').mockReturnValue(now + 61000)
    try {
      await json('/ext/image-gen/comfy/capabilities', { settings: comfyDraft })
    } finally {
      mockedClock.mockRestore()
    }
    expect(capabilityCalls).toBe(count + 1)
    const brokenDiscovery = await app.request('/api/ext/image-gen/comfy/capabilities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { comfyUrl: `${base}/broken` } }),
    })
    expect(brokenDiscovery.status).toBe(502)
    expect(await brokenDiscovery.text()).toContain('ComfyUI 能力发现失败')
    expect(
      await json('/ext/image-gen/test-connection', { settings: { openaiConnectionId: connection.id } }),
    ).toMatchObject({ ok: true })
    expect(await json('/ext/image-gen/test-connection', { settings: comfyDraft })).toMatchObject({ ok: true })
    await json('/ext/image-gen/test', {
      settings: {
        openaiConnectionId: connection.id,
        openaiModel: 'flux-dev',
        openaiHeaders: '{"X-Override":"draft-secret"}',
      },
    })
    expect(remoteRequests.some((item) => item.url === `${base}/reused/v1/images/generations`)).toBe(true)
    expect(remoteHeaders.at(-1)?.get('x-connection')).toBe('connection-secret')
    expect(remoteHeaders.at(-1)?.get('x-override')).toBe('draft-secret')
    await json('/ext/image-gen/test-connection', {
      settings: {
        openaiConnectionId: connection.id,
        openaiHeaders: '{"authorization":"Bearer image-form-secret"}',
      },
    })
    expect(remoteHeaders.at(-1)?.get('authorization')).toBe('Bearer image-form-secret')
    const savedSettings = (
      await json<{ id: string; settings: Record<string, unknown> }[]>('/extensions', undefined, 'GET')
    ).find((item) => item.id === 'image-gen')!.settings
    expect(savedSettings.openaiConnectionId).toBe('')
    expect(savedSettings.openaiModel).toBe('gpt-image-1')
    host.updateCharacterExtensions(actor.id, {
      sd_character_prompt: { positive: 'blue identity', negative: 'red identity' },
    })
    configure({
      async: false,
      source: 'openai',
      openaiConnectionId: connection.id,
      openaiModel: 'flux-dev',
      promptConnectionId: connection.id,
      promptModel: 'special-prompt-model',
      styles: [{ name: 'test', promptPrefix: 'style {prompt}', promptSuffix: 'suffix', negativePrompt: 'bad style' }],
      activeStyle: 'test',
      modeOverrides: [],
      visibleFromButton: false,
    })
    const beforePreview = bodies.length
    const preview = await json<{ snapshotId: string; prompt: string; negative: string; width: number; height: number }>(
      '/ext/image-gen/prompt',
      { chatId: chat.id, mode: 'face', negative: 'once' },
    )
    expect(bodies).toHaveLength(beforePreview)
    expect(preview.prompt).toBe('style blue identity, 1girl, blue hair, suffix')
    expect(preview.negative).toBe('bad style, red identity, once')
    expect(chatRequests.at(-1)?.model).toBe('special-prompt-model')
    expect(chatRequests.at(-1)).not.toHaveProperty('tools')
    configure({ openaiModel: 'new-model', styles: [{ name: 'test', promptPrefix: 'NEW' }] })
    host.updateCharacterExtensions(actor.id, { sd_character_prompt: { positive: 'NEW IDENTITY', negative: '' } })
    const beforeConfirm = chatRequests.length
    const confirmed = await json<{ message: MessageDTO }>('/ext/image-gen/generate', {
      chatId: chat.id,
      mode: 'face',
      snapshotId: preview.snapshotId,
      prompt: `${preview.prompt}, edited`,
      negative: preview.negative,
    })
    expect(chatRequests).toHaveLength(beforeConfirm)
    expect(bodies.at(-1)).toMatchObject({
      model: 'flux-dev',
      prompt: 'style blue identity, 1girl, blue hair, suffix, edited',
      size: '832x1216',
    })
    expect(confirmed.message.meta.imageGen).toMatchObject({
      hidden: true,
      caption: '[画师 sent an image: 1girl, blue hair]',
      negative: 'bad style, red identity, once',
    })
    expect(confirmed.message.meta.imageGen?.seed).toBeGreaterThanOrEqual(0)
    configure({
      modeOverrides: [
        {
          mode: 'face',
          enabled: true,
          promptPrefix: 'over',
          promptSuffix: 'end',
          negativePrompt: 'no',
          width: 640,
          height: 480,
        },
      ],
    })
    const overridden = await json<{ prompt: string; negative: string; width: number; height: number }>(
      '/ext/image-gen/prompt',
      { chatId: chat.id, mode: 'face' },
    )
    expect(overridden).toMatchObject({
      prompt: 'over, NEW IDENTITY, 1girl, blue hair, end',
      negative: 'no',
      width: 640,
      height: 480,
    })
    const lists = await json<{ options: { value: string; label: string }[] }>(`/ext/image-gen/styles`, {
      settings: { styles: [{ name: 'draft' }] },
    })
    expect(lists.options).toEqual([{ value: 'draft', label: 'draft' }])
    const fallback = await app.request('/api/ext/image-gen/styles', { method: 'POST', body: '{' })
    expect(fallback.status).toBe(200)
    expect(await fallback.json()).toEqual(await json('/ext/image-gen/styles', {}))
    const workflows = await json<{ options: { value: string }[] }>(`/ext/image-gen/comfy/workflows`, {
      settings: {
        comfyWorkflows: [
          { name: 'custom', json: JSON.stringify({ data: 'x'.repeat(200 * 1024) }) },
          { name: '', json: '{}' },
          { name: 'custom', json: '{}' },
        ],
      },
    })
    expect(workflows.options.map((item) => item.value)).toEqual(['', 'avatar', 'custom'])
    const inspection = await json<{ error: string }>(`/ext/image-gen/comfy/workflow-inspection`, {
      settings: { comfyWorkflowName: 'bad', comfyWorkflows: [{ name: 'bad', json: '{' }] },
    })
    expect(inspection.error).toContain('不是合法的 JSON')
    expect(inspection.error).toContain('第 1 行，第 2 列')
    const check = await json<{ valid: boolean; error?: string; placeholders: { name: string; used: boolean }[] }>(
      '/ext/image-gen/comfy/workflow-check',
      {
        settings: { comfyCustomPlaceholders: [{ find: '%custom%', replace: 'value' }] },
        json: '{"text":"%prompt% %custom%"}',
      },
    )
    expect(check.valid).toBe(true)
    expect(check.placeholders).toHaveLength(16)
    expect(check.placeholders[0]).toEqual({ name: 'prompt', used: true })
    expect(check.placeholders.at(-1)).toEqual({ name: 'custom', used: true })
    const invalidWorkflow = await json<{ valid: boolean; error: string }>('/ext/image-gen/comfy/workflow-check', {
      json: '{\n "bad": }',
    })
    expect(invalidWorkflow.valid).toBe(false)
    expect(invalidWorkflow.error).toContain('第 2 行')
    const missing = await app.request('/api/ext/image-gen/comfy/workflow-inspection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { comfyWorkflowName: 'missing', comfyWorkflows: [] } }),
    })
    expect(missing.status).toBe(502)
    expect(await missing.json()).toMatchObject({ error: { message: '找不到名为 missing 的工作流' } })
    expect((await app.request('/api/ext/image-gen/comfy/workflows')).status).toBe(404)
    // 头像提炼使用多模态消息，无头像时退回普通文本模板；请求仍不带工具。
    configure({ multimodalCaptioning: true })
    await json('/ext/image-gen/prompt', { chatId: chat.id, mode: 'face' })
    expect(Array.isArray((chatRequests.at(-1)!.messages as { content: unknown }[]).at(-1)?.content)).toBe(false)
    const { setCharacterAvatar } = await import('../../../services/characters')
    await setCharacterAvatar(actor.id, png)
    await json('/ext/image-gen/prompt', { chatId: chat.id, mode: 'face' })
    const captionRequest = chatRequests.at(-1)?.messages as {
      role: string
      content: { type: string; image_url?: { url: string } }[]
    }[]
    expect(captionRequest.at(-1)?.role).toBe('user')
    expect(captionRequest.at(-1)?.content[1]?.image_url?.url).toStartWith('data:image/png;base64,')
    expect(chatRequests.at(-1)).not.toHaveProperty('tools')
    host.updateCharacterExtensions(actor.id, { sd_character_prompt: { positive: 'identity', negative: 'char bad' } })
    configure({
      multimodalCaptioning: false,
      styles: [{ name: 'test', promptPrefix: 'style', promptSuffix: 'tail', negativePrompt: 'style bad' }],
      modeOverrides: [],
    })
    const explicitPrefix = await json<{ prompt: string; negative: string }>('/ext/image-gen/prompt', {
      chatId: chat.id,
      mode: 'free',
      input: '!{{charPrefix}}, riding a bike',
    })
    expect(explicitPrefix.prompt).toBe('style, identity, riding a bike, tail')
    expect(explicitPrefix.negative).toBe('style bad, char bad')
    const noImplicit = await json<{ prompt: string; negative: string }>('/ext/image-gen/prompt', {
      chatId: chat.id,
      mode: 'free',
      input: '!cat',
    })
    expect(noImplicit.prompt).toBe('style, cat, tail')
    expect(noImplicit.negative).toBe('style bad')
    configure({ visibleFromButton: true, visibleFromTool: false })
    const visibleImage = await json<{ message: MessageDTO }>('/ext/image-gen/generate', {
      chatId: chat.id,
      mode: 'free',
      input: '!visible cat',
    })
    expect(visibleImage.message.meta.imageGen).toMatchObject({
      hidden: false,
      caption: '[画师 sent an image: visible cat]',
    })
    const hiddenTool = await runTool('generate_image', '{"prompt":"cat"}', { chatId: chat.id, vars: {} })
    expect(hiddenTool.meta?.imageGen).toMatchObject({ hidden: true, caption: '[画师 sent an image: cat]' })
    configure({ visibleFromButton: false })
    configure({
      source: 'comfy',
      comfyUrl: base,
      openaiConnectionId: 'deleted-openai-connection',
      comfyHeaders: '{"Authorization":"Bearer workflow-secret"}',
      comfyWorkflowName: 'custom-avatar',
      comfyWorkflows: [
        {
          name: 'custom-avatar',
          json: JSON.stringify({
            node: {
              class_type: 'Mock',
              inputs: {
                who: '%who%',
                avatar: '%char_avatar%',
                user: '%user_avatar%',
                negative: '%negative_prompt%',
                denoise: '%denoise%',
                clip: '%clip_skip%',
                vae: '%vae%',
              },
            },
          }),
        },
      ],
      comfyCustomPlaceholders: [{ find: 'who', replace: '{{char}} / {{user}}' }],
      comfyVae: 'ae.safetensors',
      comfyDenoise: 0.5,
      comfyClipSkip: -2,
    })
    await json('/ext/image-gen/generate', { chatId: chat.id, mode: 'face' })
    const customBody = bodies.at(-1) as { prompt: { node: { inputs: Record<string, unknown> } } }
    expect(customBody.prompt.node.inputs).toMatchObject({
      who: '画师 / 旅人',
      user: '',
      negative: 'style bad, char bad',
      denoise: 0.5,
      clip: -2,
      vae: 'ae.safetensors',
    })
    expect(customBody.prompt.node.inputs.avatar).toBeString()
    expect(String(customBody.prompt.node.inputs.avatar).length).toBeGreaterThan(20)
    expect(remoteRequests.at(-1)?.authorization).toBe('Bearer workflow-secret')
    configure({ source: 'openai', openaiConnectionId: connection.id })
    expect(getChatRow(chat.id).apiPresetId).toBeNull()
    // 取消排队和生成中的任务，不影响其他任务；启动后修改设置不影响快照。
    configure({ async: true, maxConcurrent: 1, openaiModel: 'flux-dev', modeOverrides: [], seed: 42 })
    delay = 180
    const queued = await Promise.all(
      [0, 1, 2].map((i) =>
        json<{ message: MessageDTO }>('/ext/image-gen/generate', {
          chatId: chat.id,
          mode: 'free',
          input: `!snapshot ${i}`,
        }),
      ),
    )
    await Bun.sleep(5)
    expect(loadMessage(queued[1]!.message.id).meta.imageGen).toMatchObject({ stage: 'queued', queuePosition: 1 })
    await json('/ext/image-gen/cancel', { messageId: queued[1]!.message.id })
    expect(loadMessage(queued[1]!.message.id).meta.imageGen).toMatchObject({ status: 'error', error: '已取消' })
    configure({ openaiModel: 'changed-during-job', comfyHeaders: '{"Authorization":"never-log"}' })
    await wait(queued[0]!.message.id)
    await wait(queued[2]!.message.id)
    expect(bodies.at(-1)?.model).toBe('flux-dev')
    expect(bodies.some((body) => String(body.prompt).includes('snapshot 1'))).toBe(false)
    const cancelRunning = await json<{ message: MessageDTO }>('/ext/image-gen/generate', {
      chatId: chat.id,
      mode: 'free',
      input: '!cancel-running',
    })
    await Bun.sleep(5)
    await json('/ext/image-gen/cancel', { messageId: cancelRunning.message.id })
    await Bun.sleep(delay + 10)
    expect(loadMessage(cancelRunning.message.id).meta.imageGen).toMatchObject({ status: 'error', error: '已取消' })
    expect(loadMessage(cancelRunning.message.id).meta.images).toBeUndefined()
    // 取消后立即放弃，异步收尾不能重新写回已删除的失败格。
    const cancelDismiss = await json<{ message: MessageDTO }>('/ext/image-gen/generate', {
      chatId: chat.id,
      mode: 'free',
      input: '!cancel-dismiss',
    })
    await Bun.sleep(5)
    await json('/ext/image-gen/cancel', { messageId: cancelDismiss.message.id })
    await json('/ext/image-gen/dismiss', { messageId: cancelDismiss.message.id })
    await Bun.sleep(delay + 10)
    expect(() => loadMessage(cancelDismiss.message.id)).toThrow()
    let releasePrompt = () => {}
    textGate = new Promise<void>((resolve) => {
      releasePrompt = resolve
    })
    const cancelPrompt = await json<{ message: MessageDTO }>('/ext/image-gen/generate', {
      chatId: chat.id,
      mode: 'character',
    })
    expect(cancelPrompt.message.meta.imageGen?.stage).toBe('prompt')
    await json('/ext/image-gen/cancel', { messageId: cancelPrompt.message.id })
    releasePrompt()
    textGate = undefined
    await Bun.sleep(10)
    expect(loadMessage(cancelPrompt.message.id).meta.imageGen?.error).toBe('已取消')
    delay = 10
    configure({ interactiveMode: true, toolEnabled: false, openaiModel: 'flux-dev', visibleFromInteractive: false })
    const { emitServerEvent } = await import('../../registry')
    const userRequest = host.appendMessage(chat.id, { role: 'user', content: '画一张图：海边的小猫' })
    emitServerEvent({ type: 'message:saved', message: userRequest })
    let interactive: MessageDTO | undefined
    for (let i = 0; i < 100; i++) {
      interactive = host
        .getChatInfo(chat.id, 10)
        .messages.find((message) => message.meta.imageGen?.mode === 'free' && message.parentId === userRequest.id)
      if (interactive) break
      await Bun.sleep(10)
    }
    expect(interactive).toBeDefined()
    expect((await wait(interactive!.id)).meta.imageGen?.hidden).toBe(true)
    configure({ toolEnabled: true })
    const leafBefore = getChatRow(chat.id).activeLeafId
    emitServerEvent({ type: 'message:saved', message: { ...userRequest, content: 'send a picture of you' } })
    await Bun.sleep(20)
    expect(getChatRow(chat.id).activeLeafId).toBe(leafBefore)
    const gallery = await json<{ images: { chatId: string; messageId: string }[]; total: number }>(
      `/ext/image-gen/gallery?characterId=${actor.id}&limit=2&offset=0`,
      undefined,
      'GET',
    )
    expect(gallery.images).toHaveLength(2)
    expect(gallery.images.every((item) => item.chatId)).toBe(true)
    const nextPage = await json<{ images: { messageId: string }[] }>(
      `/ext/image-gen/gallery?characterId=${actor.id}&limit=2&offset=2`,
      undefined,
      'GET',
    )
    expect(nextPage.images).toHaveLength(2)
    expect(gallery.total).toBeGreaterThan(4)
    expect(nextPage.images[0]?.messageId).not.toBe(gallery.images[0]?.messageId)
    await json('/ext/image-gen/gallery-background', {
      chatId: chat.id,
      messageId: confirmed.message.id,
      imageId: confirmed.message.meta.images![0]!.id,
    })
    // C9 按模式提炼、显式描述、群聊角色和异步占位保持同一条工具消息。
    configure({
      source: 'openai',
      openaiConnectionId: '',
      openaiBaseUrl: `${base}/v1`,
      openaiModel: 'gpt-image-1',
      openaiExtra: '',
      openaiHeaders: '',
      async: false,
      toolEnabled: true,
      refineModelPrompts: false,
    })
    const invoke = (args: Record<string, unknown>, chatId = chat.id) =>
      runTool('generate_image', JSON.stringify(args), { chatId, vars: {} })
    for (const mode of ['character', 'portrait', 'face', 'user', 'scene', 'last', 'raw_last']) {
      host.appendMessage(chat.id, { role: 'assistant', content: 'A cat beside a lake.' })
      const beforePrompts = chatRequests.length
      const image = await invoke({ mode })
      expect(image.meta?.imageGen?.status).toBe('done')
      expect(image.meta?.imageGen?.mode).toBe(mode === 'portrait' ? 'face' : mode)
      expect(chatRequests.length - beforePrompts).toBe(mode === 'raw_last' ? 0 : 1)
    }
    const beforeDirect = chatRequests.length
    const direct = await invoke({ mode: 'portrait', prompt: 'original final description', orientation: 'landscape' })
    expect(chatRequests).toHaveLength(beforeDirect)
    expect(direct.meta?.imageGen?.prompt).toContain('original final description')
    expect(direct.meta?.imageGen?.width).toBeGreaterThan(direct.meta?.imageGen?.height ?? 0)
    expect((await invoke({ mode: 'free' })).meta?.imageGen?.status).toBe('error')
    expect((await invoke({ mode: 'unknown' })).meta?.imageGen?.status).toBe('error')
    expect((await invoke({ mode: 'character', prompt: 12 })).meta?.imageGen?.status).toBe('error')
    expect((await invoke({ mode: 'character', orientation: 'invalid' })).meta?.imageGen?.status).toBe('error')
    expect((await invoke({ mode: 'character', character: 'missing' }, groupChat.id)).meta?.imageGen?.status).toBe(
      'error',
    )
    const selectedTool = await invoke({ mode: 'character', character: actor2.name }, groupChat.id)
    expect(selectedTool.meta?.imageGen?.status).toBe('done')
    const selectedPrompt = JSON.stringify(chatRequests.at(-1))
    expect(selectedPrompt).toContain(actor2.name)
    const backgroundResult = await invoke({ mode: 'background', prompt: 'a lake' })
    expect(backgroundResult.content).toBe('Image generated and set as the chat background.')
    expect(backgroundResult.meta?.images).toHaveLength(1)
    expect(backgroundResult.meta?.imageGen).toMatchObject({ mode: 'background', status: 'done' })
    configure({ refineModelPrompts: true, promptStyle: 'natural' })
    await invoke({ mode: 'portrait', prompt: 'a detailed portrait' })
    expect(JSON.stringify(chatRequests.at(-1))).toContain('a detailed portrait')
    expect(JSON.stringify(chatRequests.at(-1))).toContain('40–90 words')
    promptFail = true
    expect((await invoke({ mode: 'free', prompt: 'fallback description' })).meta?.imageGen?.prompt).toContain(
      'fallback description',
    )
    promptFail = false
    configure({ async: true })
    const beforeQueue = chatRequests.length
    const queuedTool = await invoke({ mode: 'character' })
    expect(chatRequests).toHaveLength(beforeQueue)
    expect(JSON.parse(queuedTool.content).status).toBe('queued')
    const placeholder = host.appendMessage(chat.id, {
      role: 'tool',
      content: queuedTool.content,
      meta: queuedTool.meta,
    })
    queuedTool.onSaved?.(placeholder.id)
    expect(JSON.parse(loadMessage(placeholder.id).content)).toMatchObject({ status: 'queued', task_id: placeholder.id })
    expect((await wait(placeholder.id)).meta.imageGen?.mode).toBe('character')
    const asyncBg = await invoke({ mode: 'background', prompt: 'a quiet garden' })
    const bgPlaceholder = host.appendMessage(chat.id, { role: 'tool', content: asyncBg.content, meta: asyncBg.meta })
    asyncBg.onSaved?.(bgPlaceholder.id)
    expect(JSON.parse(loadMessage(bgPlaceholder.id).content).task_id).toBe(bgPlaceholder.id)
    const completedBg = await wait(bgPlaceholder.id)
    expect(completedBg.meta.images).toHaveLength(1)
    const imageBeforeRetry = completedBg.meta.images![0]!.id
    const backgroundBeforeRetry = getChatRow(chat.id).backgroundId
    const backgroundRetry = await json<{ message: MessageDTO }>('/ext/image-gen/retry', {
      messageId: bgPlaceholder.id,
      prompt: 'a new garden',
    })
    expect(backgroundRetry.message.id).toBe(bgPlaceholder.id)
    const retriedBg = await wait(bgPlaceholder.id)
    expect(retriedBg.meta.images).toHaveLength(2)
    expect(retriedBg.meta.images![0]!.id).toBe(imageBeforeRetry)
    expect(retriedBg.meta.images![1]!.id).not.toBe(imageBeforeRetry)
    expect(retriedBg.meta.imageIndex).toBe(1)
    expect(getChatRow(chat.id).backgroundId).not.toBe(backgroundBeforeRetry)

    const logs = listLogs({})
      .filter((log) => log.kind === 'image')
      .map((log) => getLog(log.id))
    expect(logs.length).toBeGreaterThan(10)
    expect(logs.some((log) => log.status === 'error')).toBe(true)
    const serialized = JSON.stringify(logs)
    expect(serialized).not.toContain('img3-secret-key')
    expect(serialized).not.toContain('reused-secret')
    expect(serialized).not.toContain('connection-secret')
    expect(serialized).not.toContain('draft-secret')
    expect(serialized).not.toContain('proxy-secret')
    expect(serialized).not.toContain('never-log')
    expect(serialized).not.toContain('workflow-secret')
    expect(serialized).not.toContain(png.toString('base64'))
    expect(serialized).not.toContain('b64_json')
  } finally {
    restore?.()
    await server?.stop(true)
    sqlite?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
