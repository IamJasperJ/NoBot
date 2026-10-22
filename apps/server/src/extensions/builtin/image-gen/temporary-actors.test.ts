import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CharacterDTO, ChatDTO, PlayPresetDTO, TemporaryActorDTO } from '@nobot/shared'
import { Hono } from 'hono'
import sharp from 'sharp'

test('临时立绘：存储兼容、舞台状态、自动重试和管理接口', async () => {
  if (!process.env.TEMPORARY_ACTORS_CHILD) {
    const directory = await mkdtemp(join(tmpdir(), 'nobot-temporary-actors-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        env: { ...process.env, TEMPORARY_ACTORS_CHILD: '1', DATA_DIR: directory, MOCK_LLM_FETCH: '1' },
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
  const { paths } = await import('../../../env')
  paths.db = ':memory:'
  await (await import('../../../bootstrap')).bootstrap()
  const { app } = await import('../../../app')
  const { getSetting, setSetting } = await import('../../../db/client')
  const { createExtensionHost } = await import('../../host')
  const { readTemporaryActors, writeTemporaryActor } = await import('../../../services/sprites/temporary-actors')
  const { computeStage, applyStageParse } = await import('../../../services/generation/stage')
  const { loadPath } = await import('../../../services/chats')
  const { parseSettings } = await import('./settings')
  const { autoActors } = await import('./vn6')
  const { temporaryActorRoutes, actorTasks } = await import('./temporary-actors')
  const { HttpError } = await import('../../../errors')
  const json = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const res = await app.request(`/api${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    expect(res.status, await res.clone().text()).toBe(200)
    return res.json() as Promise<T>
  }
  const character = await json<CharacterDTO>('/characters', 'POST', { name: 'Alice' })
  const chat = await json<ChatDTO>('/chats', 'POST', { characterId: character.id })
  const preset = await json<PlayPresetDTO>('/play-presets', 'POST', {
    name: '临时立绘测试',
    data: {
      directives: { enabled: true },
      sprites: { classify: 'off' },
      stage: { unknownActor: 'generate' },
    },
  })
  await json(`/chats/${chat.id}`, 'PATCH', { playPresetId: preset.id })
  const host = createExtensionHost(() => {})
  const ctx = {
    host,
    settings: parseSettings({ openaiBaseUrl: 'http://mock/v1', openaiModel: 'image', refineModelPrompts: false }),
    storage: { get: () => undefined, set: () => {}, delete: () => {} },
  }
  const routes = new Hono()
  routes.onError((error, c) => c.json({ error: error.message }, error instanceof HttpError ? error.status : 500))
  temporaryActorRoutes(routes, ctx)
  const request = (method: string, path = '', body?: unknown) =>
    routes.request(`/temporary-actors${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
  const input = { chatId: chat.id, key: 'merchant' }
  const png = await sharp({ create: { width: 8, height: 12, channels: 4, background: 'white' } })
    .png()
    .toBuffer()
  const image = await host.saveImage(png)
  setSetting(`vn-actors:${chat.id}`, { merchant: image })
  expect(readTemporaryActors(chat.id).merchant).toEqual({
    key: input.key,
    name: 'merchant',
    image,
    prompt: '',
    status: 'done',
    updatedAt: 0,
  })
  const message = host.appendMessage(chat.id, { role: 'assistant', content: '<show who="Merchant" />' })
  host.updateMessageMeta(message.id, applyStageParse(chat.id, message, message.content))
  const path = loadPath(message.id)
  for (const status of ['done', 'pending', 'error', 'removed'] as const) {
    writeTemporaryActor(chat.id, input.key, { ...readTemporaryActors(chat.id).merchant!, status })
    expect(computeStage(chat.id, path)?.cast[0]?.spriteUrl).toBe(status === 'removed' ? undefined : image.url)
  }
  const quiet = spyOn(host, 'quietPrompt').mockResolvedValue('green hair, red coat')
  let fail = false
  let gate: Promise<void> | undefined
  let release = () => {}
  const calls: Record<string, unknown>[] = []
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? '{}')))
    if (gate) await gate
    return fail
      ? Response.json({ error: { message: 'private upstream failure' } }, { status: 500 })
      : Response.json({ data: [{ b64_json: png.toString('base64') }] })
  }) as typeof fetch)
  const wait = async () => {
    for (let i = 0; i < 300 && actorTasks.size; i++) await Bun.sleep(10)
    expect(actorTasks.size).toBe(0)
    return readTemporaryActors(chat.id).merchant!
  }
  try {
    for (const status of ['removed', 'pending'] as const) {
      writeTemporaryActor(chat.id, input.key, { ...readTemporaryActors(chat.id).merchant!, status })
      await autoActors(ctx, chat.id)
    }
    expect(calls).toHaveLength(0)
    writeTemporaryActor(chat.id, input.key, { ...readTemporaryActors(chat.id).merchant!, status: 'error' })
    fail = true
    await autoActors(ctx, chat.id)
    expect(readTemporaryActors(chat.id).merchant).toMatchObject({ status: 'error', error: expect.any(String) })
    expect(readTemporaryActors(chat.id).merchant?.error).not.toContain('private upstream failure')
    fail = false
    gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const automatic = autoActors(ctx, chat.id)
    expect(readTemporaryActors(chat.id).merchant?.status).toBe('pending')
    expect((await request('POST', '/regenerate', input)).status).toBe(409)
    release()
    gate = undefined
    await automatic
    expect(readTemporaryActors(chat.id).merchant).toMatchObject({
      name: 'Merchant',
      status: 'done',
      prompt: 'green hair, red coat',
    })
    quiet.mockClear()
    gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = await request('POST', '/regenerate', { ...input, prompt: '  blue eyes  ' })
    expect(pending.status).toBe(200)
    expect(await pending.json()).toMatchObject({ status: 'pending', prompt: 'blue eyes' })
    expect((await request('POST', '/regenerate', input)).status).toBe(409)
    await autoActors(ctx, chat.id)
    expect(quiet).not.toHaveBeenCalled()
    release()
    gate = undefined
    expect(await wait()).toMatchObject({ status: 'done', prompt: 'blue eyes' })
    expect(calls.at(-1)?.prompt).toContain('blue eyes. Full body, standing')
    ctx.settings.spriteMatting = 'native'
    ctx.settings.openaiModel = 'gpt-image-1'
    expect((await request('POST', '/regenerate', input)).status).toBe(200)
    expect(await wait()).toMatchObject({ status: 'done', prompt: 'green hair, red coat' })
    expect(calls.at(-1)).toMatchObject({ background: 'transparent', output_format: 'png' })
    expect(calls.at(-1)?.prompt).toContain('white background')
    const { generateSpriteSet } = await import('../../../services/sprites/sprite-generation')
    const nativeSet = await generateSpriteSet(ctx, character.id, {
      basePrompt: 'blue hair, red coat',
      outfit: '',
      expressions: ['neutral'],
    })
    expect(nativeSet).toMatchObject({ done: 1, failed: 0 })
    const { listSprites, findSprite, spriteOriginalPath } = await import('../../../services/sprites/sprites')
    const generated = listSprites(character.id)[0]!
    expect(generated.hasOriginal).toBe(true)
    expect(await Bun.file(spriteOriginalPath(findSprite(character.id, generated.id))!).exists()).toBe(true)
    const actorOriginal = (readTemporaryActors(chat.id).merchant as TemporaryActorDTO & { original?: { id: string } })
      .original
    expect(actorOriginal).toBeTruthy()
    expect(await Bun.file(join(paths.attachments, `${actorOriginal!.id}.webp`)).exists()).toBe(true)
    expect(calls.at(-1)).toMatchObject({ background: 'transparent', output_format: 'png' })
    expect(calls.at(-1)?.prompt).toContain('white background')
    ctx.settings.spriteMatting = 'algorithm'
    expect(quiet).toHaveBeenCalledWith(expect.objectContaining({ chatId: chat.id, includeHistory: true }))
    expect((await request('DELETE', '', input)).status).toBe(200)
    expect(readTemporaryActors(chat.id).merchant).toMatchObject({ image: null, status: 'removed' })
    expect((await request('DELETE', '', { ...input, purge: true })).status).toBe(200)
    expect(readTemporaryActors(chat.id).merchant).toBeUndefined()
    expect((await request('POST', '/regenerate', { ...input, prompt: '' })).status).toBe(200)
    expect(await wait()).toMatchObject({ name: 'merchant', status: 'done' })
    for (const removeBackground of [false, true]) {
      const form = new FormData()
      form.set('chatId', chat.id)
      form.set('key', input.key)
      form.set('file', new File([png], 'sprite.png', { type: 'image/png' }))
      if (removeBackground) form.set('removeBackground', 'true')
      const uploaded = await routes.request('/temporary-actors/upload', { method: 'POST', body: form })
      expect(uploaded.status, await uploaded.clone().text()).toBe(200)
      expect(await uploaded.json()).toMatchObject({
        hasOriginal: removeBackground,
        status: 'done',
        prompt: '',
        image: { url: expect.stringContaining('/attachments/') },
      })
    }
    const before = readTemporaryActors(chat.id).merchant!
    const cutoutInput = { ...input, mode: 'algorithm' }
    const previews = await Promise.all([
      request('POST', '/cutout', { ...cutoutInput, preview: true }),
      request('POST', '/cutout', { ...cutoutInput, preview: true }),
    ])
    expect(previews.map((response) => response.status)).toEqual([200, 200])
    expect(actorTasks.size).toBe(0)
    const preview = await request('POST', '/cutout', { ...cutoutInput, preview: true })
    expect(preview.status).toBe(200)
    expect(preview.headers.get('Content-Type')).toBe('image/png')
    expect(readTemporaryActors(chat.id).merchant).toEqual(before)
    const applied = await request('POST', '/cutout', cutoutInput)
    expect(applied.status).toBe(200)
    const result = (await applied.json()) as TemporaryActorDTO & { original?: unknown }
    expect(result.image?.id).not.toBe(before.image?.id)
    expect(result.hasOriginal).toBe(true)
    expect(result.original).toBeUndefined()
    expect(result.updatedAt).toBeGreaterThan(before.updatedAt)
    const stored = readTemporaryActors(chat.id).merchant as TemporaryActorDTO & { original?: { id: string } }
    expect(stored.original).toBeTruthy()
    expect(await Bun.file(join(paths.attachments, `${stored.original!.id}.webp`)).exists()).toBe(true)
    expect(await Bun.file(join(paths.attachments, `${before.image!.id}.webp`)).exists()).toBe(false)
    for (const preview of [true, false]) {
      expect((await request('POST', '/cutout', { ...input, mode: 'model', preview })).status).toBe(400)
    }
    actorTasks.add(JSON.stringify([chat.id, input.key]))
    expect((await request('POST', '/cutout', cutoutInput)).status).toBe(409)
    expect((await request('POST', '/cutout', { ...cutoutInput, preview: true })).status).toBe(409)
    actorTasks.clear()
    await request('DELETE', '', { ...input, purge: true })
    expect(await Bun.file(join(paths.attachments, `${stored.original!.id}.webp`)).exists()).toBe(false)
    expect(await Bun.file(join(paths.attachments, `${result.image!.id}.webp`)).exists()).toBe(false)
    // 旧记录首次重抠保留当前附件；再次重抠仍使用同一附件。
    const legacy = await host.saveImage(png)
    writeTemporaryActor(chat.id, input.key, {
      key: input.key,
      name: before.name,
      prompt: '',
      status: 'done',
      updatedAt: before.updatedAt,
      image: legacy,
      hasOriginal: false,
    })
    const legacyBefore = readTemporaryActors(chat.id).merchant
    expect((await request('POST', '/cutout', { ...cutoutInput, preview: true })).status).toBe(200)
    expect(readTemporaryActors(chat.id).merchant).toEqual(legacyBefore)
    const firstCutout = await request('POST', '/cutout', cutoutInput)
    expect(firstCutout.status).toBe(200)
    const legacyStored = readTemporaryActors(chat.id).merchant as typeof stored
    expect(legacyStored.original?.id).toBe(legacy.id)
    expect((await request('POST', '/cutout', cutoutInput)).status).toBe(200)
    expect((readTemporaryActors(chat.id).merchant as typeof stored).original?.id).toBe(legacy.id)
    const invalid = new FormData()
    invalid.set('chatId', chat.id)
    invalid.set('key', input.key)
    invalid.set('file', new File(['not an image'], 'sprite.png'))
    for (const removeBackground of ['false', 'true']) {
      invalid.set('removeBackground', removeBackground)
      expect((await routes.request('/temporary-actors/upload', { method: 'POST', body: invalid })).status).toBe(400)
    }
    invalid.set('file', new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.png'))
    expect((await routes.request('/temporary-actors/upload', { method: 'POST', body: invalid })).status).toBe(400)
    writeTemporaryActor(chat.id, 'old', { ...readTemporaryActors(chat.id).merchant!, key: 'old', updatedAt: 0 })
    const list = await json<TemporaryActorDTO[]>(`/ext/image-gen/temporary-actors?chatId=${chat.id}`)
    expect(list.map((record) => record.key)).toEqual(['merchant', 'old'])
    expect(getSetting<Record<string, TemporaryActorDTO>>(`vn-actors:${chat.id}`)?.merchant?.image).toBeTruthy()
    // 关闭 VN 自动生成后仍允许清理历史记录。
    await json(`/chats/${chat.id}`, 'PATCH', { playPresetId: null })
    expect((await request('DELETE', '', { ...input, purge: true })).status).toBe(200)
  } finally {
    release()
    await wait()
    quiet.mockRestore()
    fetchMock.mockRestore()
  }
})
