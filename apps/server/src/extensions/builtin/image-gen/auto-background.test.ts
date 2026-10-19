import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CharacterDTO, type ChatDTO, type PlayPresetDTO, playPresetDataSchema } from '@nobot/shared'

test('自动背景：缺失才生成、同名并发去重、按指令名字保存；起名使用单条 user 请求', async () => {
  if (!process.env.AUTO_BACKGROUND_CHILD) {
    const directory = await mkdtemp(join(tmpdir(), 'nobot-auto-bg-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        env: { ...process.env, AUTO_BACKGROUND_CHILD: '1', DATA_DIR: directory },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, `${out}\n${err}`).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    return
  }
  const { paths } = await import('../../../env')
  paths.db = ':memory:'
  await (await import('../../../bootstrap')).bootstrap()
  const { app } = await import('../../../app')
  const { createExtensionHost } = await import('../../host')
  const { getChatRow, loadPath } = await import('../../../services/chats')
  const { listBackgrounds } = await import('../../../services/backgrounds')
  const { computeStage } = await import('../../../services/stage')
  const { autoBackground, isBackgroundRunning, missingBackground, nameBackground, promptPreview, runImageTool } =
    await import('./pipeline')
  const { parseSettings } = await import('./settings')
  const host = createExtensionHost(() => {})
  const storage = { get: () => undefined, set: () => {}, delete: () => {} }
  const settings = parseSettings({
    openaiBaseUrl: 'http://mock/v1',
    openaiModel: 'image',
    async: false,
    promptStyle: 'auto',
  })
  const ctx = { host, storage, settings }
  const json = async <T>(path: string, body: unknown, method = 'POST'): Promise<T> => {
    const response = await app.request(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json() as Promise<T>
  }
  const actor = await json<CharacterDTO>('/characters', { name: 'Alice' })
  const chat = await json<ChatDTO>('/chats', { characterId: actor.id })
  const play = await json<PlayPresetDTO>('/play-presets', {
    name: 'Test VN',
    data: { directives: { enabled: true }, sprites: { classify: 'off' } },
  })
  await json(`/chats/${chat.id}`, { playPresetId: play.id }, 'PATCH')
  const message = host.appendMessage(chat.id, {
    role: 'assistant',
    content: '<scene bg="Moonlit garden" place="Garden" time="Night" />',
    meta: { stage: { v: 1, beats: [], ops: [{ op: 'scene', bg: 'Moonlit garden', place: 'Garden', time: 'Night' }] } },
  })
  const stage = computeStage(chat.id, loadPath(message.id))!
  expect(missingBackground(play.data, message, stage)).toBe('Moonlit garden')
  expect(
    missingBackground(play.data, message, { ...stage, scene: { ...stage.scene, backgroundId: 'exists' } }),
  ).toBeNull()
  expect(missingBackground(playPresetDataSchema.parse({}), message, stage)).toBeNull()
  expect(
    missingBackground({ ...play.data, stage: { ...play.data.stage, autoBackground: false } }, message, stage),
  ).toBeNull()
  expect(missingBackground(play.data, undefined, stage)).toBeNull()
  expect(
    missingBackground(play.data, { meta: { stage: { v: 1, beats: [], ops: [{ op: 'scene', bg: '' }] } } }, stage),
  ).toBeNull()
  expect(missingBackground(play.data, message, null)).toBeNull()

  const quietCalls: Parameters<typeof host.quietPrompt>[0][] = []
  const completeCalls: Parameters<typeof host.complete>[0][] = []
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const quiet = spyOn(host, 'quietPrompt').mockImplementation(async (opts) => {
    quietCalls.push(opts)
    await gate
    return 'moonlit garden, trees, silver light'
  })
  const complete = spyOn(host, 'complete').mockImplementation(async (opts) => {
    completeCalls.push(opts)
    return '{"name":"Other name","description":"A moonlit garden."}'
  })
  const png = await (await import('sharp'))
    .default({ create: { width: 8, height: 8, channels: 3, background: '#abc' } })
    .png()
    .toBuffer()
  const { saveSprite } = await import('../../../services/sprites')
  await saveSprite(actor.id, png, 'casual', 'joy')
  await saveSprite(actor.id, png, 'casual', 'neutral')
  await saveSprite(actor.id, png, '', 'joy')
  const { assemble, loadGenerationContext } = await import('../../../services/context')
  const loaded = loadGenerationContext(chat.id, { requireConnection: false })
  const options = { type: 'normal' as const, speakerId: actor.id, leafId: message.id }
  const assembled = assemble(loaded, options)
  expect(assembled.input.injections?.find((item) => item.id === 'stage')?.content).toContain(
    'Available outfits: Alice: casual',
  )
  expect(assembled.input.injections?.find((item) => item.id === 'stage_reminder')?.position).toBe('end')
  expect(assemble(loaded, { ...options, quiet: true }).input.injections).toBeUndefined()
  expect(assemble(loaded, { ...options, type: 'impersonate' }).input.injections).toBeUndefined()
  let images = 0
  const fetched = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async () => {
        images++
        return Response.json({ data: [{ b64_json: png.toString('base64') }] })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  try {
    const running = autoBackground(ctx, chat.id)
    expect(isBackgroundRunning(chat.id)).toBe(true)
    await autoBackground(ctx, chat.id)
    expect(quietCalls).toHaveLength(1)
    release()
    await running
    expect(isBackgroundRunning(chat.id)).toBe(false)
    expect(images).toBe(1)
    expect(listBackgrounds()).toHaveLength(1)
    expect(listBackgrounds()[0]?.name).toBe('Moonlit garden')
    expect(getChatRow(chat.id).backgroundId).toBe(listBackgrounds()[0]!.id)
    const backgroundMessage = loadPath(getChatRow(chat.id).activeLeafId).at(-1)!
    expect(backgroundMessage.meta.images).toHaveLength(1)
    expect(backgroundMessage.meta.imageGen).toMatchObject({ mode: 'background', status: 'done' })
    expect(quietCalls[0]?.instruction).toContain('Location name: Moonlit garden; place: Garden; time: Night')
    expect(completeCalls[0]?.messages).toHaveLength(1)
    expect(completeCalls[0]?.messages[0]?.role).toBe('user')
    expect(completeCalls[0]).not.toHaveProperty('maxTokens')
    await autoBackground(ctx, chat.id)
    expect(images).toBe(1)
    await promptPreview(
      { ...ctx, settings: { ...settings, freeExtend: true, tpl_free: 'Custom {{input}}' } },
      { chatId: chat.id, mode: 'free', input: 'blue trees' },
    )
    expect(quietCalls.at(-1)?.instruction).toBe('Custom blue trees')
    await autoBackground({ ...ctx, settings: { ...settings, openaiBaseUrl: '' } }, chat.id)
    expect(images).toBe(1)
    complete.mockImplementation(async () => {
      throw new Error('Naming failed')
    })
    const fallback = await nameBackground(
      ctx,
      chat.id,
      settings,
      'best quality, masterpiece, forest, mist, trees',
      'Alice',
    )
    expect(fallback.name).toBe('Garden Night')
    const plain = await json<ChatDTO>('/chats', { characterId: actor.id })
    expect(
      (await nameBackground(ctx, plain.id, settings, 'best quality, masterpiece, forest, mist, trees', 'Alice')).name,
    ).toBe('forest, mist, trees')

    const toolCtx = { ...ctx, chatId: chat.id }
    await runImageTool(toolCtx, { prompt: 'A long description of a girl in a garden.' })
    expect(quietCalls.at(-1)?.instruction).toContain('A long description of a girl in a garden.')
    expect(quietCalls.at(-1)?.instruction).toContain('40–90 words')
    const before = quietCalls.length
    await runImageTool(
      { ...toolCtx, settings: { ...settings, refineModelPrompts: false } },
      { prompt: 'original description' },
    )
    expect(quietCalls).toHaveLength(before)
    await runImageTool(toolCtx, { prompt: 'A forest without people', as_background: true })
    expect(quietCalls.at(-1)?.instruction).toContain('Describe only the environment')
    expect(quietCalls.at(-1)?.instruction).toContain('Additional visual direction:\nA forest without people')
    quiet.mockImplementation(async () => {
      throw new Error('Rewrite failed')
    })
    expect((await runImageTool(toolCtx, { prompt: 'original description' })).meta?.imageGen?.prompt).toContain(
      'original description',
    )
    await runImageTool(toolCtx, { prompt: 'A forest without people', as_background: true })
    expect(images).toBe(6)
  } finally {
    quiet.mockRestore()
    complete.mockRestore()
    fetched.mockRestore()
    const { sqlite } = await import('../../../db/client')
    sqlite.close()
  }
})
