import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BackgroundDTO,
  CharacterCgDTO,
  CharacterDTO,
  ChatDTO,
  ChatPage,
  GroupDTO,
  MessageDTO,
  PlayPresetDTO,
  PromptPresetDTO,
  SpriteDTO,
  SpriteJobDTO,
} from '@nobot/shared'
import sharp from 'sharp'
import { readSSE, waitFor } from './helpers/sse'

test('VN6：CG 附件、画廊归属、立绘任务与临时演员，使用 fetch mock', async () => {
  if (!process.env.VN6_CHILD) {
    const directory = await mkdtemp(join(tmpdir(), 'nobot-vn6-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        env: { ...process.env, VN6_CHILD: '1', DATA_DIR: directory, MOCK_LLM_FETCH: '1' },
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
  const { paths } = await import('../src/env')
  paths.db = ':memory:'
  await (await import('../src/bootstrap')).bootstrap()
  const { app } = await import('../src/app')
  const { createExtensionHost } = await import('../src/extensions/host')
  const { autoCgs, autoActors } = await import('../src/extensions/builtin/image-gen/vn6')
  const { getChatRow, loadMessage, loadPath } = await import('../src/services/chats')
  const { computeStage, applyStageParse } = await import('../src/services/generation/stage')
  const { parseSettings } = await import('../src/extensions/builtin/image-gen/settings')
  const { updateExtension } = await import('../src/extensions/registry')
  const host = createExtensionHost(() => {})
  const json = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await app.request(`/api${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json() as Promise<T>
  }
  const actor = await json<CharacterDTO>('/characters', 'POST', { name: 'Alice' })
  const other = await json<CharacterDTO>('/characters', 'POST', { name: 'Bob' })
  const chat = await json<ChatDTO>('/chats', 'POST', { characterId: actor.id })
  const preset = await json<PlayPresetDTO>('/play-presets', 'POST', {
    name: 'VN6 test',
    data: {
      directives: { enabled: true, kinds: ['cg', 'cast', 'scene'] },
      sprites: { classify: 'off' },
      stage: { unknownActor: 'generate', autoBackground: false },
    },
  })
  expect(preset.data.stage.cgAuto).toBe(true)
  await json(`/chats/${chat.id}`, 'PATCH', { playPresetId: preset.id })
  const settings = parseSettings({
    openaiBaseUrl: 'http://mock/v1',
    openaiModel: 'image',
    refineModelPrompts: true,
    resolution: 'custom',
    width: 512,
    height: 768,
  })
  updateExtension('image-gen', { settings })
  const ctx = { host, settings, storage: { get: () => undefined, set: () => {}, delete: () => {} } }
  const quiet = spyOn(host, 'quietPrompt').mockResolvedValue('blue hair, standing character')
  const png = await sharp({ create: { width: 12, height: 18, channels: 4, background: '#ffffff' } })
    .png()
    .toBuffer()
  const calls: Record<string, unknown>[] = []
  const referenceCalls: Record<string, unknown>[] = []
  const cgRefinements: string[] = []
  let failImage = false
  let release: (() => void) | undefined
  let gate: Promise<void> | undefined
  let textResponse: ((body: Record<string, unknown>) => Response | Promise<Response>) | undefined
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body ?? '{}')) as Record<string, unknown>
    if (body.model === 'vn-text' && textResponse) return textResponse(body)
    if (body.model === 'vn-cg-refinement') {
      const request = JSON.stringify(body.messages)
      cgRefinements.push(request)
      const content = request.includes('The following describes a background image')
        ? '{"name":"Courtyard","description":"A quiet courtyard."}'
        : 'stone terraces, painted iron doors'
      return Response.json({ choices: [{ message: { content } }] })
    }
    if (body.model === 'gemini-sprite-test') {
      referenceCalls.push(body)
      return Response.json({ choices: [{ message: { content: `data:image/png;base64,${png.toString('base64')}` } }] })
    }
    if ('prompt' in body) {
      calls.push(body)
      if (gate) await gate
      if (failImage) return Response.json({ error: { message: 'failure' } }, { status: 500 })
      if (String(url).includes('/sdapi/'))
        return Response.json({ images: [png.toString('base64')], info: JSON.stringify({ seed: 12345 }) })
      return Response.json({ data: [{ b64_json: png.toString('base64') }] })
    }
    return Response.json({ choices: [{ message: { content: 'blue hair, blue eyes' }, finish_reason: 'stop' }] })
  }) as typeof fetch)
  try {
    const append = (input: Parameters<typeof host.appendMessage>[1]) => {
      const message = host.appendMessage(chat.id, input)
      return host.updateMessageMeta(message.id, applyStageParse(chat.id, message, message.content))
    }
    const original = await host.saveImage(png)
    const message = append({
      role: 'assistant',
      speakerId: actor.id,
      content: '<cg prompt="garden" />\nText\n<cg prompt="night" />',
      meta: { images: [original] },
    })
    const beats = message.meta.stage!.beats.flatMap((beat, index) => (beat.kind === 'cg' ? [index] : []))
    gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = autoCgs(ctx, chat.id, message.id)
    await autoCgs(ctx, chat.id, message.id)
    expect(loadMessage(message.id).meta.cg?.map((entry) => entry.status)).toEqual(['pending', 'pending'])
    release!()
    gate = undefined
    await pending
    const saved = loadMessage(message.id)
    expect(calls).toHaveLength(2)
    expect(saved.meta.images).toHaveLength(3)
    expect(saved.meta.cg?.map((entry) => entry.beat)).toEqual(beats)
    expect(
      saved.meta.cg?.every(
        (entry) =>
          entry.status === 'done' && saved.meta.images?.some((image) => image.id === entry.attachmentId && image.isCg),
      ),
    ).toBe(true)
    expect(quiet).toHaveBeenCalledTimes(2)
    expect(calls[0]!.size).toBe('768x512')
    await autoCgs(ctx, chat.id, message.id)
    expect(calls).toHaveLength(2)
    const gallery = await json<CharacterCgDTO[]>(`/characters/${actor.id}/cgs`)
    expect(gallery).toHaveLength(2)
    expect(gallery[0]!.createdAt).toBeGreaterThanOrEqual(gallery[1]!.createdAt)
    expect(gallery.every((image) => image.chatId === chat.id && image.messageId === message.id)).toBe(true)
    await json(`/attachments/${gallery[0]!.id}`, 'PATCH', { isCg: false })
    expect(await json<CharacterCgDTO[]>(`/characters/${actor.id}/cgs`)).toHaveLength(1)
    await json(`/attachments/${original.id}`, 'PATCH', { isCg: true })
    expect(loadMessage(message.id).meta.images?.find((image) => image.id === original.id)?.isCg).toBe(true)
    const group = await json<GroupDTO>('/groups', 'POST', {
      name: 'Party',
      members: [{ characterId: actor.id }, { characterId: other.id }],
    })
    const groupChat = await json<ChatDTO>('/chats', 'POST', { groupId: group.id })
    host.appendMessage(groupChat.id, {
      role: 'assistant',
      speakerId: other.id,
      content: 'Bob CG',
      meta: { images: [{ ...original, isCg: true }] },
    })
    expect(await json<CharacterCgDTO[]>(`/characters/${other.id}/cgs`)).toHaveLength(1)
    expect(await json<CharacterCgDTO[]>(`/characters/${actor.id}/cgs`)).toHaveLength(2)

    updateExtension('image-gen', { settings: { ...settings, source: 'a1111', a1111Url: 'http://mock' } })
    gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { jobId } = await json<{ jobId: string }>(`/characters/${actor.id}/sprites/generate`, 'POST', {
      outfit: 'coat',
      expressions: ['joy', 'neutral', 'joy', 'sadness'],
      basePrompt: 'blue hair',
    })
    const busy = await app.request(`/api/characters/${actor.id}/sprites/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outfit: '', expressions: ['neutral'] }),
    })
    expect(busy.status).toBe(409)
    const wrongOwner = await app.request(`/api/characters/${other.id}/sprites/generate/${jobId}`)
    expect(wrongOwner.status).toBe(404)
    release!()
    gate = undefined
    const waitJob = async (id: string): Promise<SpriteJobDTO> => {
      for (let attempt = 0; attempt < 300; attempt++) {
        const state = await json<SpriteJobDTO>(`/characters/${actor.id}/sprites/generate/${id}`)
        if (state.status === 'done' || state.status === 'error') return state
        await Bun.sleep(5)
      }
      throw new Error('Job timed out')
    }
    expect(await waitJob(jobId)).toEqual({ total: 3, done: 3, failed: 0, status: 'done' })
    const sprites = await json<SpriteDTO[]>(`/characters/${actor.id}/sprites`)
    expect(sprites.map((sprite) => sprite.expression).sort()).toEqual(['joy', 'neutral', 'sadness'])
    expect(calls[2]!.prompt).toContain('neutral expression')
    expect(calls[3]!.prompt).toContain('smile, happy')
    expect(calls[2]!.width).toBe(512)
    expect(calls[2]!.height).toBe(768)
    expect(calls[3]!.seed).toBe(12345)
    expect(calls[4]!.seed).toBe(12345)
    const bytes = await Bun.file(join(paths.sprites, actor.id, `${sprites[0]!.id}.png`)).arrayBuffer()
    const raw = await sharp(bytes).ensureAlpha().raw().toBuffer()
    expect(raw[3]).toBe(0)

    // 不提供 basePrompt 时使用模型从角色卡提取外貌。
    await json('/connections', 'POST', { name: 'Prompt', baseUrl: 'http://mock/v1', model: 'prompt' })
    const appearanceJob = await json<{ jobId: string }>(`/characters/${actor.id}/sprites/generate`, 'POST', {
      outfit: 'summer',
      expressions: ['neutral'],
    })
    expect((await waitJob(appearanceJob.jobId)).done).toBe(1)
    expect(calls.at(-1)!.prompt).toContain('blue hair, blue eyes')

    // 聊天出图后端：第二张引用第一张白底原图，所选服装名保留在绘图描述中。
    const referenceSettings = { ...settings, openaiModel: 'gemini-sprite-test' }
    updateExtension('image-gen', { settings: referenceSettings })
    const referenceJob = await json<{ jobId: string }>(`/characters/${actor.id}/sprites/generate`, 'POST', {
      outfit: 'outfit-id-42',
      expressions: ['joy', 'neutral'],
      basePrompt: 'blue hair, blue dress',
    })
    expect((await waitJob(referenceJob.jobId)).done).toBe(2)
    const firstMessages = referenceCalls[0]!.messages as { content: string }[]
    expect(firstMessages[0]!.content).toContain('neutral expression')
    expect(firstMessages[0]!.content).toContain('outfit-id-42')
    expect(firstMessages[0]!.content).toContain('head to shoes')
    const secondMessages = referenceCalls[1]!.messages as {
      content: { type: string; text?: string; image_url?: { url: string } }[]
    }[]
    expect(secondMessages[0]!.content[0]!.text).toContain('change only the facial expression')
    expect(secondMessages[0]!.content[0]!.text).toContain('smile, happy')
    expect(secondMessages[0]!.content[1]!.image_url?.url).toBe(`data:image/png;base64,${png.toString('base64')}`)
    const referenceSprites = (await json<SpriteDTO[]>(`/characters/${actor.id}/sprites`)).filter(
      (sprite) => sprite.outfit === 'outfit-id-42',
    )
    expect(referenceSprites).toHaveLength(2)
    updateExtension('image-gen', { settings: { ...settings, source: 'a1111', a1111Url: 'http://mock' } })

    failImage = true
    const failedJob = await json<{ jobId: string }>(`/characters/${actor.id}/sprites/generate`, 'POST', {
      outfit: '',
      expressions: ['neutral'],
      basePrompt: 'blue hair',
    })
    expect(await waitJob(failedJob.jobId)).toEqual({ total: 1, done: 0, failed: 1, status: 'error' })
    const badCg = append({ role: 'assistant', content: '<cg prompt="bad" />' })
    await autoCgs(ctx, chat.id, badCg.id)
    expect(loadMessage(badCg.id).meta.cg?.[0]?.status).toBe('error')
    const count = calls.length
    await autoCgs(ctx, chat.id, badCg.id)
    expect(calls.length).toBe(count)
    failImage = false
    const npc = append({ role: 'assistant', content: '<show who="Merchant" />\n<show who="Bob" />' })
    // 单聊中 Bob 不是角色卡映射，因此两者都保存为会话临时演员。
    await Promise.all([autoActors(ctx, chat.id), autoActors(ctx, chat.id)])
    const stage = computeStage(chat.id, loadPath(npc.id))!
    expect(stage.cast.every((member) => member.spriteUrl?.includes('/attachments/'))).toBe(true)
    expect(loadMessage(npc.id).meta.spriteGeneration).toBe('done')
    const actorCount = calls.length
    await autoActors(ctx, chat.id)
    expect(calls.length).toBe(actorCount)
    const alice = append({ role: 'assistant', content: '<show who="Alice" />' })
    await autoActors(ctx, chat.id)
    expect(calls.length).toBe(actorCount)
    expect(computeStage(chat.id, loadPath(alice.id))?.cast.find((member) => member.name === 'Alice')?.characterId).toBe(
      actor.id,
    )
    // 有角色卡但没有立绘时也补一张 neutral，复用角色立绘服务。
    await json(`/chats/${groupChat.id}`, 'PATCH', { playPresetId: preset.id })
    const bob = host.appendMessage(groupChat.id, {
      role: 'assistant',
      speakerId: other.id,
      content: '<show who="Bob" />',
    })
    host.updateMessageMeta(bob.id, applyStageParse(groupChat.id, bob, bob.content))
    await autoActors(ctx, groupChat.id)
    expect((await json<SpriteDTO[]>(`/characters/${other.id}/sprites`)).map((sprite) => sprite.expression)).toEqual([
      'neutral',
    ])

    const edit = (id: string, content: string) => json<MessageDTO>(`/messages/${id}`, 'PATCH', { content })
    const reordered = await edit(message.id, '<cg prompt="night" />\nA new line\n<cg prompt="garden" />')
    const originalCgImages = new Map(saved.meta.cg!.map((entry) => [entry.prompt, entry.attachmentId]))
    expect(reordered.meta.cg?.map(({ beat, prompt, attachmentId }) => ({ beat, prompt, attachmentId }))).toEqual([
      { beat: beats[0], prompt: 'night', attachmentId: originalCgImages.get('night') },
      { beat: beats[1], prompt: 'garden', attachmentId: originalCgImages.get('garden') },
    ])
    const replaced = await edit(message.id, '<cg prompt="river" />\nText\n<cg prompt="garden" />')
    expect(replaced.meta.cg).toMatchObject([
      { beat: beats[1], prompt: 'garden', attachmentId: originalCgImages.get('garden') },
    ])
    expect(replaced.meta.images).toHaveLength(3)
    host.updateMessageMeta(message.id, { cg: saved.meta.cg })
    await json(`/chats/${chat.id}`)
    expect(loadMessage(message.id).meta.cg).toEqual(replaced.meta.cg)

    // 旧任务迟到时，删掉的指令不恢复，移动过的指令仍可使用原任务的结果。
    const changing = append({ role: 'assistant', content: '<cg prompt="discard" />\n<cg prompt="keep" />' })
    const held = Promise.withResolvers<void>()
    gate = held.promise
    const beforeEdit = calls.length
    const rendering = autoCgs(ctx, chat.id, changing.id)
    try {
      await waitFor(() => calls.length > beforeEdit)
      const edited = await edit(changing.id, 'Narration\n<cg prompt="keep" />\n<cg prompt="new" />')
      expect(edited.meta.cg).toMatchObject([{ beat: 1, prompt: 'keep', status: 'pending' }])
    } finally {
      gate = undefined
      held.resolve()
    }
    await rendering
    expect(loadMessage(changing.id).meta.cg).toMatchObject([{ beat: 1, prompt: 'keep', status: 'done' }])
    expect(loadMessage(changing.id).meta.images).toHaveLength(1)
    await autoCgs(ctx, chat.id, changing.id)
    expect(loadMessage(changing.id).meta.cg).toMatchObject([
      { beat: 1, prompt: 'keep', status: 'done' },
      { beat: 2, prompt: 'new', status: 'done' },
    ])

    // CG 在续写请求等待期间完成时，文本落库必须保留最新的附件和 CG 状态。
    const textConnection = await json<{ id: string }>('/connections', 'POST', {
      name: 'VN text',
      baseUrl: 'http://mock/v1',
      model: 'vn-text',
    })
    await json(`/chats/${chat.id}`, 'PATCH', { apiPresetId: textConnection.id })
    const continuing = append({ role: 'assistant', speakerId: actor.id, content: '<cg prompt="existing" />' })
    const heldImage = Promise.withResolvers<void>()
    const heldText = Promise.withResolvers<void>()
    const requestedText = Promise.withResolvers<void>()
    gate = heldImage.promise
    textResponse = async () => {
      requestedText.resolve()
      await heldText.promise
      const frame = JSON.stringify({ choices: [{ delta: { content: '\nNarration\n<cg prompt="continued" />' } }] })
      return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    const beforeContinue = calls.length
    const inFlightCg = autoCgs(ctx, chat.id, continuing.id)
    await waitFor(() => calls.length > beforeContinue)
    const continuation = readSSE(
      await app.request(`/api/chats/${chat.id}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'continue', targetId: continuing.id }),
      }),
    )
    try {
      await Promise.race([
        requestedText.promise,
        continuation.then((events) => {
          throw new Error(`续写未调用模拟模型：${JSON.stringify(events)}`)
        }),
      ])
      gate = undefined
      heldImage.resolve()
      await inFlightCg
      expect(loadMessage(continuing.id).meta.cg?.[0]?.status).toBe('done')
    } finally {
      gate = undefined
      heldImage.resolve()
      heldText.resolve()
    }
    expect((await continuation).some((event) => event.type === 'error')).toBe(false)
    const continued = loadMessage(continuing.id)
    expect(continued.meta.cg?.[0]).toMatchObject({ prompt: 'existing', status: 'done' })
    expect(continued.meta.images?.[0]?.id).toBe(continued.meta.cg?.[0]?.attachmentId)
    await autoCgs(ctx, chat.id, continuing.id)
    await waitFor(() => loadMessage(continuing.id).meta.cg?.[1]?.status === 'done')
    expect(loadMessage(continuing.id).meta.cg?.map(({ prompt }) => prompt)).toEqual(['existing', 'continued'])

    // 两名角色各自生成 CG，工具调用轮不出图；先发言角色的第二张图不能读到后续角色的话。
    await json(`/groups/${group.id}`, 'PATCH', { activation: 'list' })
    await json(`/play-presets/${preset.id}`, 'PATCH', {
      data: { ...preset.data, stage: { ...preset.data.stage, autoBackground: true } },
    })
    const toolPreset = await json<PromptPresetDTO>('/presets', 'POST', {
      name: 'VN CG tool round',
      data: { samplers: { functionCalling: true } },
    })
    const cgChat = await json<ChatDTO>('/chats', 'POST', { groupId: group.id })
    await json(`/chats/${cgChat.id}`, 'PATCH', {
      playPresetId: preset.id,
      promptPresetId: toolPreset.id,
      apiPresetId: textConnection.id,
    })
    updateExtension('image-gen', {
      enabled: true,
      settings: { ...settings, promptModel: 'vn-cg-refinement', promptConnectionId: textConnection.id },
    })
    const frames = [
      {
        delta: {
          content: '<scene bg="Dice draft cave" />\n<cg prompt="dice draft" />',
          tool_calls: [
            {
              index: 0,
              id: 'cg-dice',
              type: 'function',
              function: { name: 'roll_dice', arguments: '{"expression":"1d6"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
      {
        delta: {
          content:
            'Alice enters the amber courtyard.\n<scene bg="Amber courtyard" place="Courtyard" />\n<cg prompt="Amber arches" />\n<cg prompt="Courtyard fountain" />',
        },
      },
      { delta: { content: 'Bob opens the silver floodgate.\n<cg prompt="Silver floodgate" />' } },
    ]
    textResponse = () =>
      new Response(`data: ${JSON.stringify({ choices: [frames.shift()] })}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    const heldGroupImages = Promise.withResolvers<void>()
    gate = heldGroupImages.promise
    const beforeGroupImages = calls.length
    const groupEvents = await app
      .request(`/api/chats/${cgChat.id}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'send', text: 'What is beyond those doors?' }),
      })
      .then((response) => readSSE(response))
      .finally(() => {
        gate = undefined
        heldGroupImages.resolve()
      })
    expect(groupEvents.some((event) => event.type === 'error')).toBe(false)
    const groupReplies = groupEvents.flatMap((event) => (event.type === 'done' ? [event.message] : []))
    expect(groupReplies.map((reply) => reply.speakerId)).toEqual([actor.id, actor.id, other.id])
    const [toolRound, aliceReply, bobReply] = groupReplies as [MessageDTO, MessageDTO, MessageDTO]
    await waitFor(() =>
      [aliceReply, bobReply].every(({ id }) => {
        const cg = loadMessage(id).meta.cg
        return cg?.length && cg.every(({ status }) => status === 'done')
      }),
    )
    expect(loadMessage(toolRound.id).meta.cg).toBeUndefined()
    expect(loadMessage(aliceReply.id).meta.cg?.map(({ prompt }) => prompt)).toEqual([
      'Amber arches',
      'Courtyard fountain',
    ])
    expect(loadMessage(bobReply.id).meta.cg?.map(({ prompt }) => prompt)).toEqual(['Silver floodgate'])
    const secondAliceCg = cgRefinements.find((request) => request.includes('Courtyard fountain'))
    expect(secondAliceCg).toContain('Alice enters the amber courtyard')
    expect(secondAliceCg).not.toContain('Bob opens the silver floodgate')

    // 第一位角色切换场景，第二位继续在原场景发言。背景应在这一轮正常出图并留在该路径。
    await waitFor(() => loadPath(getChatRow(cgChat.id).activeLeafId, 1)[0]?.meta.imageGen?.mode === 'background')
    const afterBackground = await json<ChatPage>(`/chats/${cgChat.id}`)
    const backgrounds = (await json<BackgroundDTO[]>('/backgrounds')).filter((item) => item.chatId === cgChat.id)
    expect(backgrounds.map(({ name }) => name)).toEqual(['Amber courtyard'])
    expect(afterBackground.stage?.scene.backgroundId).toBe(backgrounds[0]?.id)
    expect(afterBackground.messages.at(-1)).toMatchObject({ parentId: bobReply.id, speakerId: actor.id })
    const backgroundPrompt = cgRefinements.find((request) => request.includes('Location name: Amber courtyard'))
    expect(backgroundPrompt).toContain('Alice enters the amber courtyard')
    expect(backgroundPrompt).not.toContain('Bob opens the silver floodgate')
    expect(calls.length - beforeGroupImages).toBe(4)

    updateExtension('image-gen', { enabled: false })
    const disabled = await app.request(`/api/characters/${other.id}/sprites/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outfit: '', expressions: ['neutral'], basePrompt: 'man' }),
    })
    expect(disabled.status).toBe(400)
  } finally {
    quiet.mockRestore()
    fetchMock.mockRestore()
  }
}, 15000)
