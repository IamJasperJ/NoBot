import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CharacterDTO, ChatDTO, PromptPresetDTO } from '@nobot/shared'

// 独立进程隔离数据库、扩展注册表与网络替身，避免污染其他集成测试。
test('工具图片、预算、扩展信号、取消配对和超时续写', async () => {
  if (!process.env.TOOL_IMAGE_TEST_CHILD) {
    const directory = await mkdtemp(join(tmpdir(), 'nobot-tool-images-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        env: { ...process.env, DATA_DIR: directory, TOOL_IMAGE_TEST_CHILD: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, out + err).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    return
  }
  await (await import('../src/bootstrap')).bootstrap()
  const { app } = await import('../src/app')
  const registry = await import('../src/extensions/registry')
  const { runTool } = await import('../src/tools')
  const { setSetting } = await import('../src/db/client')
  const { createExtensionHost } = await import('../src/extensions/host')
  const { startGeneration, abortGeneration, subscribe } = await import('../src/services/generation/generation')
  const { loadPath, getChatRow } = await import('../src/services/chats')
  const { loadGenerationContext, toHistory, assemble } = await import('../src/services/generation/context')
  const { replaceImageAttachments } = await import('../src/services/caption')
  const sharp = (await import('sharp')).default
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 3, background: 'red' } })
    .png()
    .toBuffer()
  async function json<T>(path: string, data?: unknown, method = 'POST'): Promise<T> {
    const response = await app.request(`/api${path}`, {
      method,
      ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    })
    const value = await response.json()
    expect(response.status, JSON.stringify(value)).toBe(200)
    return value as T
  }
  const actor = await json<CharacterDTO>('/characters', { name: 'Observer' })
  const chat = await json<ChatDTO>('/chats', { characterId: actor.id })
  await json('/connections', {
    name: 'Tool images',
    baseUrl: 'http://tool-images.test/v1',
    model: 'gpt-4o',
    vision: 'yes',
  })
  const preset = (await json<PromptPresetDTO[]>('/presets', undefined, 'GET'))[0]!
  await json(
    `/presets/${preset.id}`,
    {
      data: {
        ...preset.data,
        samplers: { ...preset.data.samplers, inlineImages: true, functionCalling: true, stream: false },
      },
    },
    'PATCH',
  )
  let mode = 'image'
  let entered: (() => void) | undefined
  let seenSignal: AbortSignal | undefined
  registry.registerBuiltinExtension({
    id: 'tool-image-fixture',
    name: '工具图片测试',
    description: '',
    version: '1',
    tools: [
      {
        name: 'fixture_image',
        description: 'Return an image.',
        parameters: {},
        run: (_args, ctx) => {
          expect(ctx.extension?.chatId).toBe(ctx.chatId)
          seenSignal = ctx.signal
          return { content: 'Screenshot', images: [{ bytes, mime: 'image/png' }] }
        },
      },
      {
        name: 'fixture_invalid',
        description: 'Invalid image fixture.',
        parameters: {},
        run: (args) => ({
          content: 'Invalid',
          images:
            args.kind === 'count'
              ? Array(5).fill('bad-id')
              : [
                  {
                    mime: args.kind === 'mime' ? 'text/plain' : 'image/png',
                    bytes: args.kind === 'size' ? new Uint8Array(10 * 1024 * 1024 + 1) : new Uint8Array([1, 2, 3]),
                  },
                ],
        }),
      },
      {
        name: 'fixture_slow',
        description: 'Wait for cancellation.',
        parameters: {},
        run: async (_args, ctx) => {
          seenSignal = ctx.signal
          entered?.()
          return new Promise((resolve) =>
            ctx.signal.addEventListener('abort', () => resolve({ content: 'Late result must not be saved' }), {
              once: true,
            }),
          )
        },
      },
      {
        name: 'fixture_timeout',
        description: 'Timeout fixture.',
        parameters: {},
        timeoutMs: 15,
        run: async (_args, ctx) => {
          seenSignal = ctx.signal
          return new Promise((resolve) =>
            ctx.signal.addEventListener('abort', () => resolve({ content: 'Late timeout result' }), { once: true }),
          )
        },
      },
    ],
  })
  const requests: Record<string, unknown>[] = []
  const mocked = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        init?.signal?.throwIfAborted()
        const body = JSON.parse(String(init?.body))
        requests.push(body)
        const hasResult = body.messages.some((message: { role: string }) => message.role === 'tool')
        const tool = mode === 'timeout' ? 'fixture_timeout' : mode === 'abort' ? 'fixture_slow' : 'fixture_image'
        return Response.json({
          choices: [
            {
              message: hasResult
                ? { content: 'I see the result.' }
                : {
                    content: '',
                    tool_calls: [tool, 'fixture_image'].map((name, i) => ({
                      id: `call-${i}`,
                      type: 'function',
                      function: { name, arguments: '{}' },
                    })),
                  },
              finish_reason: hasResult ? 'stop' : 'tool_calls',
            },
          ],
        })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  const host = createExtensionHost(() => {})
  const wait = (id: string) =>
    new Promise<void>((resolve) =>
      subscribe(startGeneration(id, { mode: 'send', text: 'TOOLIMAGE', images: [] }), (event) => {
        if (event.type === 'complete') resolve()
      }),
    )
  try {
    const direct = await runTool('fixture_image', '{}', {
      chatId: chat.id,
      vars: {},
      signal: new AbortController().signal,
    })
    expect(direct.meta?.images?.[0]).toMatchObject({ width: 8, height: 6 })
    registry.registerBuiltinExtension({
      id: 'tool-image-id-fixture',
      name: '附件工具测试',
      description: '',
      version: '1',
      tools: [
        {
          name: 'fixture_existing',
          description: 'Return existing attachments.',
          parameters: {},
          run: () => ({ content: 'Existing', images: Array(4).fill(direct.meta!.images![0]!.id) }),
        },
      ],
    })
    const existing = await runTool('fixture_existing', '{}', {
      chatId: chat.id,
      vars: {},
      signal: new AbortController().signal,
    })
    expect(existing.meta?.images).toEqual(Array(4).fill(direct.meta!.images![0]!))
    for (const kind of ['mime', 'size', 'count', 'decode']) {
      const invalid = await runTool('fixture_invalid', JSON.stringify({ kind }), {
        chatId: chat.id,
        vars: {},
        signal: new AbortController().signal,
      })
      expect(invalid.content).toContain('Tool execution failed')
      expect(invalid.meta?.images).toBeUndefined()
    }
    await wait(chat.id)
    const path = loadPath(getChatRow(chat.id).activeLeafId)
    const tools = path.filter((m) => m.role === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools.every((m) => m.meta.images?.length === 1)).toBe(true)
    expect(requests).toHaveLength(2)
    expect((requests[1]!.messages as { role: string }[]).slice(-3).map((m) => m.role)).toEqual(['tool', 'tool', 'user'])
    const ctx = loadGenerationContext(chat.id, { requireConnection: true })
    expect(
      toHistory(ctx, getChatRow(chat.id).activeLeafId).filter((m) => m.role === 'tool' && m.images?.length),
    ).toHaveLength(2)
    ctx.preset.samplers.toolImageLimit = 1
    let history = toHistory(ctx, getChatRow(chat.id).activeLeafId)
    expect(history.filter((m) => m.role === 'tool' && m.images?.length)).toHaveLength(1)
    expect(history.find((m) => m.id === tools[0]?.id)?.content).toContain('images omitted')
    ctx.preset.samplers.toolImageLimit = 0
    expect(toHistory(ctx, getChatRow(chat.id).activeLeafId).some((m) => m.role === 'tool' && m.images?.length)).toBe(
      false,
    )
    ctx.preset.samplers.toolImageLimit = 2
    history = toHistory(ctx, getChatRow(chat.id).activeLeafId)
    for (const connection of [
      { ...ctx.connection!, vision: 'no' as const },
      { ...ctx.connection!, model: 'unknown-model', vision: 'auto' as const },
    ]) {
      const text = replaceImageAttachments(history, connection)
      expect(text.some((m) => m.images?.length)).toBe(false)
      expect(text.find((m) => m.role === 'tool')?.content).toContain('this model cannot view images')
    }
    const generated = host.appendMessage(chat.id, {
      role: 'tool',
      content: 'Generated',
      meta: { images: direct.meta?.images, imageGen: { status: 'done', mode: 'tool' } },
    })
    expect(toHistory(ctx, generated.id).at(-1)?.images).toBeUndefined()
    setSetting('ext:image-gen', { seeGeneratedImages: true })
    expect(toHistory(ctx, generated.id).at(-1)?.images).toHaveLength(1)
    setSetting('ext:image-gen', { seeGeneratedImages: false })

    mode = 'timeout'
    const timeoutChat = await json<ChatDTO>('/chats', { characterId: actor.id })
    await wait(timeoutChat.id)
    const timeoutPath = loadPath(getChatRow(timeoutChat.id).activeLeafId)
    expect(timeoutPath.find((m) => m.role === 'tool')?.content).toBe('Tool timed out after 0.015s.')
    expect(timeoutPath.at(-1)?.content).toBe('I see the result.')

    mode = 'abort'
    const abortChat = await json<ChatDTO>('/chats', { characterId: actor.id })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const requestsBeforeAbort = requests.length
    const finished = wait(abortChat.id)
    await started
    abortGeneration(abortChat.id)
    await finished
    expect(seenSignal?.aborted).toBe(true)
    expect(requests.length).toBe(requestsBeforeAbort + 1)
    const aborted = loadPath(getChatRow(abortChat.id).activeLeafId)
    expect(aborted.find((m) => m.role === 'assistant' && m.meta.toolCalls)?.status).toBe('aborted')
    expect(aborted.filter((m) => m.role === 'tool').map((m) => m.content)).toEqual([
      'Tool call aborted by user.',
      'Tool call aborted by user.',
    ])
    expect(aborted.filter((m) => m.role === 'tool').every((m) => m.status === 'aborted')).toBe(true)
    const next = assemble(loadGenerationContext(abortChat.id, { requireConnection: true }), {
      type: 'normal',
      speakerId: actor.id,
      leafId: getChatRow(abortChat.id).activeLeafId,
    })
    expect(next.messages.filter((m) => m.role === 'tool')).toHaveLength(2)
    await wait(abortChat.id)
    expect(loadPath(getChatRow(abortChat.id).activeLeafId).at(-1)).toMatchObject({
      status: 'done',
      content: 'I see the result.',
    })
  } finally {
    mocked.mockRestore()
  }
}, 30000)
