import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CharacterCgDTO,
  CharacterDTO,
  ChatDTO,
  GroupDTO,
  PlayPresetDTO,
  SpriteDTO,
  SpriteJobDTO,
} from '@ai-parter/shared'
import sharp from 'sharp'

test('VN6：CG 附件、画廊归属、立绘任务与临时演员，使用 fetch mock', async () => {
  if (!process.env.VN6_CHILD) {
    const directory = await mkdtemp(join(tmpdir(), 'ai-parter-vn6-'))
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
  const { loadMessage, loadPath } = await import('../src/services/chats')
  const { computeStage, applyStageParse } = await import('../src/services/stage')
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
      directives: { enabled: true, kinds: ['cg', 'cast'] },
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
  let failImage = false
  let release: (() => void) | undefined
  let gate: Promise<void> | undefined
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body ?? '{}')) as Record<string, unknown>
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
    const pending = autoCgs(ctx, chat.id)
    await autoCgs(ctx, chat.id)
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
    await autoCgs(ctx, chat.id)
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
    await autoCgs(ctx, chat.id)
    expect(loadMessage(badCg.id).meta.cg?.[0]?.status).toBe('error')
    const count = calls.length
    await autoCgs(ctx, chat.id)
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
})
