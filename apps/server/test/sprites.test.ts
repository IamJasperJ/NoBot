import { expect, test } from 'bun:test'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CharacterDTO,
  ChatDTO,
  GenerateEvent,
  MessageDTO,
  PlayPresetDTO,
  SpriteDTO,
  SpriteImportResult,
} from '@nobot/shared'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { mockLlm } from './helpers/mockLlm'
import { readSSE } from './helpers/sse'
import { makeZip } from './helpers/zip'

test('VN2：立绘、CharX、演员与情绪判断集成', async () => {
  if (!process.env.VN2_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', 'apps/server/test/sprites.test.ts'], {
      env: { ...process.env, VN2_TEST_CHILD: '1', MOCK_LLM_FETCH: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const deadline = setTimeout(() => child.kill(), 25000)
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, `${out}\n${err}`).toBe(0)
    } finally {
      clearTimeout(deadline)
    }
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'nobot-vn2-'))
  process.env.DATA_DIR = directory
  const { paths } = await import('../src/env')
  paths.db = ':memory:'
  const { bootstrap } = await import('../src/bootstrap')
  await bootstrap()
  const { db, sqlite, newId } = await import('../src/db/client')
  const { messages, sprites, generationLogs } = await import('../src/db/schema')
  const { app } = await import('../src/app')
  const { computeStage } = await import('../src/services/stage')
  const { loadMessage } = await import('../src/services/chats')
  const { classifyMessage } = await import('../src/services/classify')
  const model = mockLlm()
  const request = (path: string, method = 'GET', body?: unknown) =>
    app.request(`/api${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
  async function json<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await request(path, method, body)
    const value = await response.json()
    expect(response.status, JSON.stringify(value)).toBe(200)
    return value as T
  }
  const png = await sharp({
    create: { width: 20, height: 40, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } },
  })
    .png()
    .toBuffer()
  const webp = await sharp(png).webp().toBuffer()
  async function upload<T>(
    path: string,
    files: [string, string, Uint8Array][],
    fields: Record<string, string> = {},
  ): Promise<T> {
    const body = new FormData()
    for (const [field, name, data] of files) body.append(field, new File([new Uint8Array(data)], name))
    for (const [key, value] of Object.entries(fields)) body.set(key, value)
    const response = await app.request(`/api${path}`, { method: 'POST', body })
    const value = await response.json()
    expect(response.status, JSON.stringify(value)).toBe(200)
    return value as T
  }
  async function generate(chatId: string, body: unknown = { mode: 'send', text: '你好' }) {
    const events = await readSSE(await request(`/chats/${chatId}/generate`, 'POST', body))
    const done = events.filter((event): event is Extract<GenerateEvent, { type: 'done' }> => event.type === 'done')
    expect(done.length, JSON.stringify(events)).toBeGreaterThan(0)
    return done.at(-1)!.message
  }
  async function settled(id: string) {
    for (let i = 0; i < 200; i++) {
      const message = loadMessage(id)
      if (message.meta.stage?.classify !== 'pending') return message
      await Bun.sleep(5)
    }
    throw new Error('情绪判断未完成')
  }
  try {
    const actor = await json<CharacterDTO>('/characters', 'POST', { name: 'Ellie Sunleaf' })
    const base = `/characters/${actor.id}/sprites`
    const explicit = await upload<SpriteImportResult>(base, [['files', '无法推断.png', png]], {
      expression: 'LOVE',
      outfit: '礼服',
    })
    expect(explicit.added[0]).toMatchObject({ expression: 'love', outfit: '礼服', width: 20, height: 40 })
    const inferred = await upload<SpriteImportResult>(base, [
      ['files', 'joy-2.png', png],
      ['files', '未知.png', png],
      ['files', 'sadness.png', webp],
    ])
    expect(inferred.added.map((sprite) => sprite.expression)).toEqual(['joy', 'sadness'])
    expect(inferred.added[1]!.url.endsWith('.webp')).toBe(true)
    expect(inferred.skipped).toEqual(['未知.png：无法从文件名判断表情，请在对应格子里上传'])
    const first = inferred.added[0]!
    const original = await app.request(first.url)
    expect(original.status).toBe(200)
    expect(original.headers.get('Content-Type')).toBe('image/png')
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(new Uint8Array(png))
    expect(original.headers.get('Cache-Control')).toContain('31536000')
    const thumb = await app.request(first.thumbUrl)
    expect(thumb.status).toBe(200)
    const metadata = await sharp(await thumb.arrayBuffer()).metadata()
    expect(metadata.height).toBe(256)
    expect(metadata.hasAlpha).toBe(true)
    expect((await app.request('/api/assets/sprites/bad/bad.png')).status).toBe(400)
    expect((await app.request(`/api/assets/sprites/${actor.id}/${newId()}.png`)).status).toBe(404)
    const zipped = await upload<SpriteImportResult>(`${base}/import`, [
      [
        'file',
        '立绘.zip',
        makeZip([
          { path: 'neutral.png', data: png, method: 8 },
          { path: 'casual/joy.png', data: png },
          { path: 'casual/sadness.webp', data: webp, method: 8 },
          { path: 'readme.txt', data: new TextEncoder().encode('说明') },
          { path: 'casual/未知.png', data: png },
          { path: '../evil.png', data: png },
        ]),
      ],
    ])
    expect(zipped.added.map((sprite) => [sprite.outfit, sprite.expression])).toEqual([
      ['', 'neutral'],
      ['casual', 'joy'],
      ['casual', 'sadness'],
    ])
    expect(zipped.skipped.length).toBe(2)
    expect(zipped.skipped[0]).toBe('readme.txt：不是图片')
    // 指定了服装：根目录的图片归入这套服装，子目录仍是自己的服装
    const intoOutfit = await upload<SpriteImportResult>(
      `${base}/import`,
      [
        [
          'file',
          '泳装.zip',
          makeZip([
            { path: 'joy.png', data: png },
            { path: 'casual/surprise.png', data: png },
          ]),
        ],
      ],
      { outfit: '泳装' },
    )
    expect(intoOutfit.added.map((sprite) => [sprite.outfit, sprite.expression])).toEqual([
      ['泳装', 'joy'],
      ['casual', 'surprise'],
    ])
    // 多选删除：别的角色的、不存在的 id 忽略
    expect(
      await json(`${base}/delete`, 'POST', { ids: [...intoOutfit.added.map((sprite) => sprite.id), newId()] }),
    ).toEqual({ deleted: 2 })
    expect((await request(`${base}/delete`, 'POST', { ids: [] })).status).toBe(400)
    expect((await app.request(intoOutfit.added[0]!.url)).status).toBe(404)
    const listing = await json<SpriteDTO[]>(base)
    expect(listing.map((sprite) => sprite.outfit)).toEqual(['', '', '', 'casual', 'casual', '礼服'])
    const updated = await json<SpriteDTO>(`${base}/${first.id}`, 'PATCH', { expression: 'ANGER', outfit: '新衣' })
    expect(updated).toMatchObject({ expression: 'anger', outfit: '新衣' })
    await json(`${base}/${first.id}`, 'DELETE')
    expect((await app.request(first.url)).status).toBe(404)
    expect((await app.request(first.thumbUrl)).status).toBe(404)
    expect(await json(`${base}?outfit=casual`, 'DELETE')).toEqual({ deleted: 2 })
    expect(await json(`${base}?outfit=`, 'DELETE')).toEqual({ deleted: 2 })
    const stranger = await json<CharacterDTO>('/characters', 'POST', { name: '其他人' })
    expect((await request(`/characters/${stranger.id}/sprites/${explicit.added[0]!.id}`, 'DELETE')).status).toBe(404)
    expect((await request(`${base}/${explicit.added[0]!.id}`, 'PATCH', { expression: '非法' })).status).toBe(400)
    const copy = await json<CharacterDTO>(`/characters/${actor.id}/duplicate`, 'POST')
    expect(await json(`/characters/${copy.id}/sprites`)).toEqual([])

    const raw = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: 'CharX',
        assets: [
          { type: 'icon', name: 'other', uri: 'https://example.com/icon.png' },
          { type: 'icon', name: 'other', uri: 'embeded://assets/other.png' },
          { type: 'icon', name: 'main', uri: 'embedded://assets/main.webp' },
          { type: 'emotion', name: 'JOY', uri: 'embeded://assets/joy.png' },
          { type: 'emotion', name: 'sadness', uri: 'embedded://assets/sadness.webp' },
          { type: 'emotion', name: 'anger', uri: 'https://example.com/anger.png' },
        ],
      },
    }
    const charx = makeZip([
      { path: 'card.json', data: new TextEncoder().encode(JSON.stringify(raw)), method: 8 },
      { path: 'assets/other.png', data: png },
      { path: 'assets/main.webp', data: webp },
      { path: 'assets/joy.png', data: png },
      { path: 'assets/sadness.webp', data: webp },
    ])
    const preview = await upload<{ hasAvatar: boolean }>('/characters/import/preview', [['file', 'card.charx', charx]])
    expect(preview.hasAvatar).toBe(true)
    const imported = await upload<CharacterDTO>('/characters/import', [['file', 'card.charx', charx]])
    expect(imported.name).toBe('CharX')
    expect(imported.avatarUrl).toBeTruthy()
    expect((await app.request(imported.avatarUrl!)).status).toBe(200)
    const importedSprites = await json<SpriteDTO[]>(`/characters/${imported.id}/sprites`)
    expect(importedSprites.map((sprite) => sprite.expression)).toEqual(['joy', 'sadness'])
    expect(importedSprites.every((sprite) => sprite.outfit === '')).toBe(true)
    const avatarMeta = await sharp(await Bun.file(join(paths.avatars, `${imported.id}.png`)).arrayBuffer()).metadata()
    expect(avatarMeta.format).toBe('png')

    const chat = await json<ChatDTO>('/chats', 'POST', { characterId: actor.id })
    const preset = await json<PlayPresetDTO>('/play-presets', 'POST', {
      name: 'VN2',
      data: {
        directives: { enabled: true },
        sprites: { classify: 'missing', classifyContext: 'last' },
      },
    })
    await json(`/chats/${chat.id}`, 'PATCH', { playPresetId: preset.id })
    const stage = computeStage(chat.id, [
      {
        meta: {
          stage: {
            v: 1,
            beats: [],
            ops: [
              { op: 'show', who: ' eLLie  Sunleaf ' },
              { op: 'show', who: 'Ellie' },
              { op: 'show', who: '路人' },
            ],
          },
        },
      },
    ])
    expect(stage?.cast.map((actor) => actor.characterId)).toEqual([actor.id, actor.id, null])
    await upload(
      base,
      [
        ['files', 'joy.png', png],
        ['files', 'sadness.png', png],
      ],
      { outfit: '情绪' },
    )
    // 仅保留两种表情，所有服装的去重标签必须出现在请求里。
    await json(`${base}?outfit=${encodeURIComponent('礼服')}`, 'DELETE')
    await json('/connections', 'POST', { name: '模拟模型', baseUrl: model.url, model: 'mock-one' })
    let release: (() => void) | undefined
    let wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const originalFetch = globalThis.fetch
    let classificationStarted: (() => void) | undefined
    let started = new Promise<void>((resolve) => {
      classificationStarted = resolve
    })
    // 延迟非流式判断，使 pending 与并发编辑可确定地验证。
    globalThis.fetch = (async (input, init) => {
      if (init?.body && typeof init.body === 'string' && JSON.parse(init.body).stream === false) {
        classificationStarted?.()
        await wait
      }
      return originalFetch(input, init)
    }) as typeof fetch
    model.setScript((body) => ({ text: body.stream ? 'Ellie：开心\n<scene bg="森林" />' : '"joy"' }))
    let generated: MessageDTO
    try {
      generated = await generate(chat.id)
      await started
      expect(loadMessage(generated.id).meta.stage?.classify).toBe('pending')
      release!()
      expect((await settled(generated.id)).meta.stage).toMatchObject({
        classify: 'done',
        ops: expect.arrayContaining([{ op: 'expr', who: actor.name, expression: 'joy' }]),
      })
      const classification = model.requests.find((body) => !body.stream)!
      expect(classification.max_tokens).toBe(20)
      expect(classification.messages.length).toBe(2)
      expect(classification.messages[0]!.content).toContain('joy, sadness')
      expect(classification.messages[0]!.content).not.toContain('neutral')
      expect(classification.messages[1]!.content).not.toContain('<scene')
      const beforeEdit = model.requests.length
      await json(`/messages/${generated.id}`, 'PATCH', { content: '修改后的台词' })
      await Bun.sleep(10)
      expect(model.requests.length).toBe(beforeEdit)
      expect(loadMessage(generated.id).meta.stage?.classify).toBeUndefined()
      model.setScript((body) => ({ text: body.stream ? 'Ellie[joy]：明确情绪' : 'sadness' }))
      const explicitMessage = await generate(chat.id)
      expect(explicitMessage.meta.stage?.classify).toBeUndefined()
      model.setScript((body) => ({ text: body.stream ? '路人[joy]：你好\nEllie：你好' : 'I think it is sadness.' }))
      const sad = await generate(chat.id)
      expect((await settled(sad.id)).meta.stage?.ops.at(-1)).toEqual({
        op: 'expr',
        // 沿用消息里对说话人的写法（Ellie），不用角色卡全名，免得同一个人以两个名字上台
        who: 'Ellie',
        expression: 'sadness',
      })
      preset.data.sprites.classify = 'always'
      await json(`/play-presets/${preset.id}`, 'PATCH', { data: preset.data })
      model.setScript((body) => ({ text: body.stream ? 'Ellie[joy]：你好' : '乱码' }))
      const failed = await generate(chat.id)
      expect((await settled(failed.id)).meta.stage?.classify).toBe('error')
      expect(loadMessage(failed.id).meta.stage?.ops.at(-1)).toEqual({ op: 'expr', who: 'Ellie', expression: 'joy' })
      model.setScript((body) => ({ text: body.stream ? 'Ellie[joy]：你好' : 'sadness' }))
      const always = await generate(chat.id)
      expect((await settled(always.id)).meta.stage?.ops.at(-1)?.op).toBe('expr')
      expect((await settled(always.id)).meta.stage?.ops.at(-1)).toEqual({
        op: 'expr',
        // 沿用消息里对说话人的写法（Ellie），不用角色卡全名，免得同一个人以两个名字上台
        who: 'Ellie',
        expression: 'sadness',
      })
      const continued = await generate(chat.id, { mode: 'continue', targetId: always.id })
      expect((await settled(continued.id)).meta.stage?.classify).toBe('done')
      // 挂起判断期间编辑或删除消息，不得把过期结果写回去。
      for (const action of ['edit', 'delete']) {
        wait = new Promise<void>((resolve) => {
          release = resolve
        })
        started = new Promise<void>((resolve) => {
          classificationStarted = resolve
        })
        const pending = await generate(chat.id)
        await started
        if (action === 'edit') await json(`/messages/${pending.id}`, 'PATCH', { content: '编辑后的内容' })
        else db.delete(messages).where(eq(messages.id, pending.id)).run()
        release!()
        await Bun.sleep(25)
        if (action === 'edit') expect(loadMessage(pending.id).meta.stage?.classify).toBeUndefined()
        else expect(db.select().from(messages).where(eq(messages.id, pending.id)).get()).toBeUndefined()
        // 删除叶子时还原，供下一次生成读取会话。
        if (action === 'delete') {
          const { chats } = await import('../src/db/schema')
          db.update(chats).set({ activeLeafId: pending.parentId }).where(eq(chats.id, chat.id)).run()
        }
      }
      const id = newId()
      db.insert(messages)
        .values({
          id,
          chatId: chat.id,
          role: 'assistant',
          content: '无说话人',
          status: 'done',
          createdAt: Date.now(),
          meta: { stage: { v: 1, ops: [], beats: [] } },
        })
        .run()
      classifyMessage(id)
      expect(loadMessage(id).meta.stage?.classify).toBeUndefined()
      preset.data.sprites.classifyContext = 'full'
      await json(`/play-presets/${preset.id}`, 'PATCH', { data: preset.data })
      const full = await generate(chat.id)
      expect((await settled(full.id)).meta.stage?.classify).toBe('done')
      expect(model.requests.filter((body) => !body.stream).at(-1)!.messages.length).toBeGreaterThan(2)
      const alternate = await json<{ id: string }>('/connections', 'POST', {
        name: '判断专用连接',
        baseUrl: model.url,
        model: 'connection-model',
        headers: { 'X-Classify': 'yes' },
      })
      await json(`${base}?outfit=${encodeURIComponent('情绪')}`, 'DELETE')
      preset.data.sprites.classifyContext = 'last'
      preset.data.sprites.classifyConnectionId = alternate.id
      preset.data.sprites.classifyModel = 'classify-model'
      preset.data.sprites.classifyPrompt = '请选择 {{labels}}'
      preset.data.sprites.customExpressions = ['sleepy']
      await json(`/play-presets/${preset.id}`, 'PATCH', { data: preset.data })
      model.setScript((body) => ({ text: body.stream ? 'Ellie：困了' : 'sleepy' }))
      const fallback = await generate(chat.id)
      expect((await settled(fallback.id)).meta.stage?.ops.at(-1)).toEqual({
        op: 'expr',
        who: 'Ellie',
        expression: 'sleepy',
      })
      const fallbackRequest = model.requests.filter((body) => !body.stream).at(-1)!
      expect(fallbackRequest.model).toBe('classify-model')
      expect(fallbackRequest.messages[0]!.content).toStartWith('请选择 ')
      expect(fallbackRequest.messages[0]!.content).toContain('neutral')
      expect(fallbackRequest.messages[0]!.content).toContain('sleepy')
      expect(model.receivedHeaders.at(-1)!.get('X-Classify')).toBe('yes')
      preset.data.sprites.classifyModel = ''
      await json(`/play-presets/${preset.id}`, 'PATCH', { data: preset.data })
      const defaultModel = await generate(chat.id)
      await settled(defaultModel.id)
      expect(model.requests.filter((body) => !body.stream).at(-1)!.model).toBe('connection-model')
      for (const disabled of ['off', 'directives']) {
        if (disabled === 'off') preset.data.sprites.classify = 'off'
        else {
          preset.data.sprites.classify = 'always'
          preset.data.directives.enabled = false
        }
        await json(`/play-presets/${preset.id}`, 'PATCH', { data: preset.data })
        const before = model.requests.filter((body) => !body.stream).length
        const ignored = await generate(chat.id)
        expect(ignored.meta.stage?.classify).toBeUndefined()
        expect(model.requests.filter((body) => !body.stream).length).toBe(before)
      }
      // 无立绘时保留目录，仍需验证删除角色会清理空目录。
      expect(
        db
          .select()
          .from(generationLogs)
          .all()
          .some((log) => log.kind === 'extension' && log.summary === '情绪判断：sadness'),
      ).toBe(true)
      expect(
        db
          .select()
          .from(generationLogs)
          .all()
          .some((log) => log.summary.includes('情绪判断：模型没有返回')),
      ).toBe(true)
    } finally {
      release?.()
      globalThis.fetch = originalFetch
    }
    await access(join(paths.sprites, actor.id))
    await json(`/characters/${actor.id}`, 'DELETE')
    await access(join(paths.sprites, actor.id))
    await json(`/trash/characters/${actor.id}`, 'DELETE')
    expect(await Bun.file(join(paths.sprites, actor.id, `${explicit.added[0]!.id}.png`)).exists()).toBe(false)
    await expect(access(join(paths.sprites, actor.id))).rejects.toThrow()
    expect(db.select().from(sprites).where(eq(sprites.characterId, actor.id)).all()).toEqual([])
  } finally {
    await model.stop()
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
