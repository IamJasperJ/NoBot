import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AttachmentDTO,
  type CharacterDTO,
  type ChatDTO,
  type PlayPresetDTO,
  playPresetDataSchema,
} from '@nobot/shared'

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
  const { listBackgrounds } = await import('../../../services/backgrounds/backgrounds')
  const { computeStage } = await import('../../../services/generation/stage')
  const {
    autoBackground,
    generate,
    isBackgroundRunning,
    missingBackground,
    nameBackground,
    promptPreview,
    retry,
    runImageTool,
    toBackground,
  } = await import('./pipeline')
  const { trackImageLifetime } = await import('./pipeline/state')
  const { parseSettings } = await import('./settings')
  const host = createExtensionHost(() => {})
  const savedRequests = new Map<string, unknown>()
  const storage = {
    get: <T>(key: string) => savedRequests.get(key) as T | undefined,
    set: (key: string, value: unknown) => void savedRequests.set(key, value),
    delete: (key: string) => void savedRequests.delete(key),
  }
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
  const { saveSprite } = await import('../../../services/sprites/sprites')
  await saveSprite(actor.id, png, 'casual', 'joy')
  await saveSprite(actor.id, png, 'casual', 'neutral')
  await saveSprite(actor.id, png, '', 'joy')
  const { assemble, loadGenerationContext } = await import('../../../services/generation/context')
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
    const running = autoBackground(ctx, chat.id, message.id)
    expect(isBackgroundRunning(chat.id)).toBe(true)
    await autoBackground(ctx, chat.id, message.id)
    const sameScene = host.appendMessage(chat.id, {
      role: 'assistant',
      content: '<scene bg="moonlit GARDEN" />',
      meta: { stage: { v: 1, beats: [], ops: [{ op: 'scene', bg: 'moonlit GARDEN' }] } },
    })
    const duplicate = autoBackground(ctx, chat.id, sameScene.id)
    expect(quietCalls).toHaveLength(1)
    release()
    await Promise.all([running, duplicate])
    expect(isBackgroundRunning(chat.id)).toBe(false)
    expect(images).toBe(1)
    expect(listBackgrounds()).toHaveLength(1)
    const garden = listBackgrounds()[0]!
    expect(garden.name).toBe('Moonlit garden')
    expect(getChatRow(chat.id).backgroundId).toBeNull()
    const backgroundMessage = loadPath(getChatRow(chat.id).activeLeafId).at(-1)!
    expect(backgroundMessage.parentId).toBe(sameScene.id)
    expect(computeStage(chat.id, loadPath(backgroundMessage.id))?.scene.backgroundId).toBe(garden.id)
    expect(backgroundMessage.meta.images).toHaveLength(1)
    expect(backgroundMessage.meta.imageGen).toMatchObject({ mode: 'background', status: 'done' })
    expect(quietCalls[0]?.instruction).toContain('Location name: Moonlit garden; place: Garden; time: Night')
    expect(completeCalls[0]?.messages).toHaveLength(1)
    expect(completeCalls[0]?.messages[0]?.role).toBe('user')
    expect(completeCalls[0]).not.toHaveProperty('maxTokens')
    await autoBackground(ctx, chat.id, message.id)
    expect(images).toBe(1)
    await promptPreview(
      { ...ctx, settings: { ...settings, freeExtend: true, tpl_free: 'Custom {{input}}' } },
      { chatId: chat.id, mode: 'free', input: 'blue trees' },
    )
    expect(quietCalls.at(-1)?.instruction).toBe('Custom blue trees')
    await autoBackground({ ...ctx, settings: { ...settings, openaiBaseUrl: '' } }, chat.id, message.id)
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

    const selectBranch = (messageId: string) => json(`/chats/${chat.id}/activate`, { messageId, exact: true })
    const appendScene = (bg: string) =>
      host.appendMessage(chat.id, {
        role: 'assistant',
        content: `<scene bg="${bg}" />`,
        meta: { stage: { v: 1, beats: [], ops: [{ op: 'scene', bg }] } },
      })
    const preserved = { backgroundId: garden.id, backgroundPinned: true }
    await json(`/chats/${chat.id}`, preserved, 'PATCH')
    await selectBranch(backgroundMessage.id)
    const retried = await retry(ctx, backgroundMessage.id)
    expect(retried.message.meta.images).toHaveLength(2)
    expect(listBackgrounds()[0]?.name).toBe('Moonlit garden')
    expect(getChatRow(chat.id)).toMatchObject(preserved)

    // 图片返回前切到同名场景的另一分支，只保存素材。回到旧分支时舞台仍能匹配这张图。
    quiet.mockImplementation(async () => 'isolated mountain station')
    const rendering = Promise.withResolvers<void>()
    const finishRender = Promise.withResolvers<void>()
    fetched.mockImplementation(
      Object.assign(
        async () => {
          rendering.resolve()
          await finishRender.promise
          return Response.json({ data: [{ b64_json: png.toString('base64') }] })
        },
        { preconnect: fetch.preconnect },
      ),
    )
    const station = appendScene('Mountain station')
    const pendingRender = autoBackground(ctx, chat.id, station.id)
    await rendering.promise
    try {
      await selectBranch(backgroundMessage.id)
      const alternateStation = appendScene('Mountain station')
      finishRender.resolve()
      await pendingRender
      expect(getChatRow(chat.id)).toMatchObject({ ...preserved, activeLeafId: alternateStation.id })
    } finally {
      finishRender.resolve()
    }
    expect(listBackgrounds()[0]).toMatchObject({ name: 'Mountain station', chatId: chat.id })
    await selectBranch(station.id)
    expect(computeStage(chat.id, loadPath(station.id))?.scene.backgroundId).toBe(listBackgrounds()[0]?.id)

    // 附件刚写入时切换分支，收尾应清理副本，避免把消息挂到选中的其他分支。
    const attachmentSaved = Promise.withResolvers<AttachmentDTO>()
    const finishAttachment = Promise.withResolvers<void>()
    const saveImage = host.saveImage
    const save = spyOn(host, 'saveImage').mockImplementation(async (bytes) => {
      const attachment = await saveImage(bytes)
      attachmentSaved.resolve(attachment)
      await finishAttachment.promise
      return attachment
    })
    try {
      const terminal = appendScene('Seaside ferry terminal')
      const pendingAppend = autoBackground(ctx, chat.id, terminal.id)
      const attachment = await attachmentSaved.promise
      try {
        await selectBranch(backgroundMessage.id)
      } finally {
        finishAttachment.resolve()
      }
      await pendingAppend
      expect(getChatRow(chat.id)).toMatchObject({ ...preserved, activeLeafId: backgroundMessage.id })
      expect(listBackgrounds()[0]).toMatchObject({ name: 'Seaside ferry terminal', chatId: chat.id })
      expect(await Bun.file(join(paths.attachments, `${attachment.id}.webp`)).exists()).toBe(false)
      expect(await Bun.file(join(paths.attachments, `${attachment.id}.json`)).exists()).toBe(false)
      expect(isBackgroundRunning(chat.id)).toBe(false)
    } finally {
      save.mockRestore()
    }

    const manual = { chatId: chat.id, mode: 'background' as const, prompt: 'a blue forest' }
    const latestChoice = await host.saveBackground(png, { name: 'Manual choice', source: 'upload' })
    const waitRender = () => {
      const started = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      fetched.mockImplementation(
        Object.assign(
          async () => {
            started.resolve()
            await resume.promise
            return Response.json({ data: [{ b64_json: png.toString('base64') }] })
          },
          { preconnect: fetch.preconnect },
        ),
      )
      return { started: started.promise, resume: resume.resolve }
    }
    const choosing = waitRender()
    const manualDraw = generate(ctx, manual)
    try {
      await choosing.started
      await json(`/chats/${chat.id}`, { backgroundId: latestChoice.id, backgroundPinned: true }, 'PATCH')
      choosing.resume()
      const result = await manualDraw
      expect(result).toMatchObject({
        background: { id: expect.any(String) },
        backgroundApplied: false,
        message: { meta: { images: expect.any(Array) } },
      })
      expect(getChatRow(chat.id)).toMatchObject({ backgroundId: latestChoice.id, backgroundPinned: true })
    } finally {
      choosing.resume()
      await manualDraw
    }

    const branching = waitRender()
    const anotherDraw = generate(ctx, manual)
    try {
      await branching.started
      await selectBranch(station.id)
      branching.resume()
      expect(await anotherDraw).toEqual({
        background: expect.objectContaining({ chatId: chat.id }),
        backgroundApplied: false,
      })
      expect(getChatRow(chat.id)).toMatchObject({ activeLeafId: station.id, backgroundId: latestChoice.id })
    } finally {
      branching.resume()
      await anotherDraw
    }

    const naming = Promise.withResolvers<void>()
    const finishName = Promise.withResolvers<void>()
    complete.mockImplementation(async () => {
      naming.resolve()
      await finishName.promise
      return '{"name":"Gallery background"}'
    })
    const beforeGallery = listBackgrounds().map((background) => background.id)
    const gallery = toBackground(ctx, backgroundMessage.id, 0)
    try {
      await naming.promise
      await json(`/chats/${chat.id}`, preserved, 'PATCH')
      finishName.resolve()
      await expect(gallery).rejects.toMatchObject({ status: 409, code: 'BACKGROUND_CONTEXT_CHANGED' })
      expect(getChatRow(chat.id)).toMatchObject(preserved)
      expect(listBackgrounds().map((background) => background.id)).toEqual(beforeGallery)
    } finally {
      finishName.resolve()
      await gallery.catch(() => {})
    }

    let lifetime = new AbortController()
    trackImageLifetime(lifetime.signal)
    const beforeCancel = listBackgrounds().map((background) => background.id)
    const persisted = host.saveBackground.bind(host)
    let discardedBackground: string | undefined
    let discardedImage: string | undefined
    const holdBackground = spyOn(host, 'saveBackground').mockImplementation(async (...args) => {
      const saved = await persisted(...args)
      discardedBackground = saved.id
      return saved
    })
    const stopAfterSave = spyOn(host, 'saveImage').mockImplementation(async (bytes) => {
      const saved = await saveImage(bytes)
      discardedImage = saved.id
      lifetime.abort()
      return saved
    })
    try {
      await expect(generate(ctx, manual)).rejects.toMatchObject({ code: 'IMAGE_CANCELLED' })
      expect(getChatRow(chat.id)).toMatchObject({ ...preserved, activeLeafId: station.id })
      expect(listBackgrounds().map((background) => background.id)).toEqual(beforeCancel)
      expect(discardedBackground).toBeString()
      expect(discardedImage).toBeString()
      expect(await Bun.file(join(paths.backgrounds, `${discardedBackground}.webp`)).exists()).toBe(false)
      expect(await Bun.file(join(paths.backgrounds, `${discardedBackground}.thumb.webp`)).exists()).toBe(false)
      expect(await Bun.file(join(paths.attachments, `${discardedImage}.webp`)).exists()).toBe(false)

      lifetime = new AbortController()
      trackImageLifetime(lifetime.signal)
      discardedBackground = undefined
      stopAfterSave.mockImplementation(async (bytes) => {
        const saved = await saveImage(bytes)
        if (!discardedBackground) throw new Error('预期背景已经写入')
        host.setChatBackground(plain.id, discardedBackground)
        lifetime.abort()
        return saved
      })
      await expect(generate(ctx, manual)).rejects.toMatchObject({ code: 'IMAGE_CANCELLED' })
      expect(discardedBackground).toBeString()
      expect(getChatRow(plain.id).backgroundId).toBe(String(discardedBackground))
      expect(getChatRow(chat.id)).toMatchObject(preserved)
      expect(await Bun.file(join(paths.backgrounds, `${discardedBackground}.webp`)).exists()).toBe(true)
    } finally {
      lifetime.abort()
      holdBackground.mockRestore()
      stopAfterSave.mockRestore()
    }
  } finally {
    quiet.mockRestore()
    complete.mockRestore()
    fetched.mockRestore()
    const { sqlite } = await import('../../../db/client')
    sqlite.close()
  }
})
