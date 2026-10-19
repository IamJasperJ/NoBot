import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackgroundDTO, ChatDTO } from '@nobot/shared'
import sharp from 'sharp'

test('背景上传、设置、删除与校验使用独立数据库', async () => {
  if (!process.env.BACKGROUND_TEST_CHILD) {
    const directory = await mkdtemp(join(tmpdir(), 'nobot-backgrounds-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', 'apps/server/test/backgrounds.test.ts'], {
        env: { ...process.env, DATA_DIR: directory, BACKGROUND_TEST_CHILD: '1' },
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
  const { initDatabase, sqlite } = await import('../src/db/client')
  initDatabase()
  const { seedPlayPresets } = await import('../src/services/playPresets.builtin')
  seedPlayPresets()
  const { app } = await import('../src/app')
  const { paths } = await import('../src/env')
  const { saveBackground, checkBackgroundSize, detectBackgroundMime } = await import('../src/services/backgrounds')
  const request = (path: string, method = 'GET', body?: unknown) =>
    app.request(`/api${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
  const json = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await request(path, method, body)
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json() as Promise<T>
  }
  const upload = (bytes: Uint8Array, name?: string) => {
    const form = new FormData()
    form.append('file', new File([bytes], '风景.png'))
    if (name !== undefined) form.append('name', name)
    return app.request('/api/backgrounds', { method: 'POST', body: form })
  }
  try {
    expect((await request('/backgrounds/auto', 'POST', { chatId: 'empty' })).status).toBe(400)
    const png = new Uint8Array(await Bun.file('fixtures/images/test.png').arrayBuffer())
    const response = await upload(png)
    expect(response.status).toBe(200)
    const background = (await response.json()) as BackgroundDTO
    expect(background).toMatchObject({ name: '风景', source: 'upload', width: 640, height: 480 })
    expect(await json<BackgroundDTO[]>('/backgrounds')).toEqual([background])
    const original = join(paths.backgrounds, `${background.id}.webp`)
    const thumb = join(paths.backgrounds, `${background.id}.thumb.webp`)
    expect(await Bun.file(original).exists()).toBe(true)
    expect(await Bun.file(thumb).exists()).toBe(true)
    expect(await sharp(original).metadata()).toMatchObject({ width: 640, height: 480, format: 'webp' })
    expect(await sharp(thumb).metadata()).toMatchObject({ width: 320, height: 240 })
    expect((await app.request(background.url)).status).toBe(200)
    expect((await app.request(background.thumbUrl)).status).toBe(200)
    expect((await app.request('/api/assets/backgrounds/invalid.webp')).status).toBe(400)
    expect((await app.request('/api/assets/backgrounds/01ARZ3NDEKTSV4RRFFQ69G5FAV.webp')).status).toBe(404)
    await json('/backgrounds/settings', 'PUT', { globalId: background.id })
    expect(await json('/backgrounds/settings')).toEqual({ globalId: background.id })
    expect(await json<BackgroundDTO>(`/backgrounds/${background.id}`, 'PATCH', { name: '  新风景  ' })).toMatchObject({
      name: '新风景',
    })
    const character = await json<{ id: string }>('/characters', 'POST', { name: '角色' })
    const chat = await json<ChatDTO>('/chats', 'POST', { characterId: character.id })
    expect(chat.backgroundId).toBeNull()
    expect(await json<ChatDTO>(`/chats/${chat.id}`, 'PATCH', { backgroundId: background.id })).toMatchObject({
      backgroundId: background.id,
    })
    expect((await request('/backgrounds/settings', 'PUT', { globalId: 'missing' })).status).toBe(404)
    expect((await request(`/chats/${chat.id}`, 'PATCH', { backgroundId: 'missing' })).status).toBe(404)
    expect((await request('/backgrounds/missing', 'PATCH', { name: '名字' })).status).toBe(404)
    expect((await request(`/backgrounds/${background.id}`, 'PATCH', { name: ' ' })).status).toBe(400)
    expect((await upload(png, ' ')).status).toBe(400)
    const invalid = await upload(new TextEncoder().encode('不是图片'))
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: { code: 'BAD_IMAGE', message: '无法识别的图片文件' } })
    expect((await upload(new Uint8Array(20 * 1024 * 1024 + 1))).status).toBe(413)
    expect((await app.request('/api/backgrounds', { method: 'POST', body: new FormData() })).status).toBe(400)
    await json(`/backgrounds/${background.id}`, 'DELETE')
    expect(await json('/backgrounds/settings')).toEqual({ globalId: null })
    expect((await json<{ chat: ChatDTO }>(`/chats/${chat.id}`)).chat.backgroundId).toBeNull()
    expect(await Bun.file(original).exists()).toBe(false)
    expect(await Bun.file(thumb).exists()).toBe(false)
    expect(await json('/backgrounds')).toEqual([])
    expect((await request(`/backgrounds/${background.id}`, 'DELETE')).status).toBe(404)
    expect(detectBackgroundMime(new TextEncoder().encode('GIF87a'))).toBe('image/gif')
    expect(detectBackgroundMime(new TextEncoder().encode('GIF89a'))).toBe('image/gif')
    expect(() => checkBackgroundSize(20 * 1024 * 1024, 'image/gif')).not.toThrow()
    expect(() => checkBackgroundSize(20 * 1024 * 1024 + 1, 'image/gif')).toThrow('20MB')
    expect(() => checkBackgroundSize(100 * 1024 * 1024, 'video/mp4')).not.toThrow()
    expect(() => checkBackgroundSize(100 * 1024 * 1024 + 1, 'video/webm')).toThrow('100MB')
    const gif = await sharp(png).gif().toBuffer()
    const mp4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0])
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 1, 0, 0, 0, 0])
    for (const [bytes, mime, ext] of [
      [gif, 'image/gif', 'gif'],
      [mp4, 'video/mp4', 'mp4'],
      [webm, 'video/webm', 'webm'],
    ] as const) {
      const response = await upload(bytes, ext)
      expect(response.status).toBe(200)
      const background = (await response.json()) as BackgroundDTO
      expect(background).toMatchObject({ mime, animated: true })
      expect(background.url.endsWith(`.${ext}`)).toBe(true)
      const asset = await app.request(background.url)
      expect(asset.headers.get('Content-Type')).toBe(mime)
      expect(new Uint8Array(await asset.arrayBuffer())).toEqual(new Uint8Array(bytes))
      if (mime.startsWith('video/')) {
        expect(background).toMatchObject({ width: 0, height: 0, thumbUrl: background.url })
        expect(await Bun.file(join(paths.backgrounds, `${background.id}.thumb.webp`)).exists()).toBe(false)
        for (const [range, start, end] of [
          ['bytes=2-5', 2, 5],
          ['bytes=8-', 8, bytes.length - 1],
          ['bytes=-4', bytes.length - 4, bytes.length - 1],
          ['bytes=0-999', 0, bytes.length - 1],
        ] as const) {
          const partial = await app.request(background.url, { headers: { Range: range } })
          expect(partial.status).toBe(206)
          expect(partial.headers.get('Content-Type')).toBe(mime)
          expect(partial.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/${bytes.length}`)
          expect(partial.headers.get('Content-Length')).toBe(String(end - start + 1))
          expect(new Uint8Array(await partial.arrayBuffer())).toEqual(new Uint8Array(bytes.subarray(start, end + 1)))
        }
        for (const range of ['bytes=999-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4']) {
          const invalid = await app.request(background.url, { headers: { Range: range } })
          expect(invalid.status).toBe(416)
          expect(invalid.headers.get('Content-Range')).toBe(`bytes */${bytes.length}`)
        }
      } else {
        expect(background).toMatchObject({ width: 640, height: 480 })
        expect(await sharp(await (await app.request(background.thumbUrl)).arrayBuffer()).metadata()).toMatchObject({
          format: 'webp',
          width: 320,
        })
      }
      await json(`/backgrounds/${background.id}`, 'DELETE')
      for (const suffix of ['webp', 'thumb.webp', 'gif', 'mp4', 'webm']) {
        expect(await Bun.file(join(paths.backgrounds, `${background.id}.${suffix}`)).exists()).toBe(false)
      }
      const saved = await saveBackground(bytes, { name: '共用入口', source: 'upload' })
      expect(saved.mime).toBe(mime)
      await json(`/backgrounds/${saved.id}`, 'DELETE')
    }
    const oversized = new Uint8Array(100 * 1024 * 1024 + 1)
    oversized.set(mp4)
    expect((await upload(oversized)).status).toBe(413)
    let reply = '海边'
    let fail = false
    const modelRequests: Record<string, unknown>[] = []
    const respond = async (request: Request) => {
      if (new URL(request.url).pathname.endsWith('/chat/completions')) {
        modelRequests.push((await request.json()) as Record<string, unknown>)
        if (fail) return Response.json({ error: { message: '模拟失败' } }, { status: 500 })
        return Response.json({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] })
      }
      if (new URL(request.url).pathname === '/oversized') {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(png)
              controller.enqueue(new Uint8Array(20 * 1024 * 1024))
              controller.close()
            },
          }),
        )
      }
      if (new URL(request.url).pathname === '/missing') return new Response(null, { status: 404 })
      return new Response(png, { headers: { 'Content-Type': 'image/png' } })
    }
    let server: ReturnType<typeof Bun.serve> | undefined
    let restoreFetch: (() => void) | undefined
    if (process.env.BACKGROUND_FETCH_MOCK) {
      // 受限环境不允许监听端口时仍验证同一套 HTTP 响应和模型请求。
      const mocked = spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => respond(new Request(String(input), init)),
          { preconnect: fetch.preconnect },
        ),
      )
      restoreFetch = () => mocked.mockRestore()
    } else {
      server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: respond })
    }
    try {
      const base = `http://127.0.0.1:${server?.port ?? 12345}`
      const imported = await json<BackgroundDTO>('/backgrounds/import-url', 'POST', {
        url: `${base}/%E6%B5%B7%E8%BE%B9.png?x=1`,
      })
      expect(imported).toMatchObject({ name: '海边', mime: 'image/webp', animated: false })
      const forest = await json<BackgroundDTO>('/backgrounds/import-url', 'POST', {
        url: `${base}/image.png`,
        name: '森林',
      })
      expect(forest.name).toBe('森林')
      expect((await request('/backgrounds/import-url', 'POST', { url: 'file:///tmp/a.png' })).status).toBe(400)
      expect((await request('/backgrounds/import-url', 'POST', { url: `${base}/missing` })).status).toBe(400)
      expect((await request('/backgrounds/import-url', 'POST', { url: `${base}/oversized` })).status).toBe(413)
      const connection = await json<{ id: string }>('/connections', 'POST', {
        name: '自动选择测试',
        baseUrl: `${base}/v1`,
        model: 'mock',
        apiKey: '',
      })
      await json(`/chats/${chat.id}`, 'PATCH', { apiPresetId: connection.id })
      for (const output of ['海边', '我选择森林。', '森琳']) {
        reply = output
        const result = await json<{ background: BackgroundDTO; reply: string }>('/backgrounds/auto', 'POST', {
          chatId: chat.id,
        })
        expect(result.reply).toBe(output)
        expect(result.background.id).toBe(output === '海边' ? imported.id : forest.id)
        expect((await json<{ chat: ChatDTO }>(`/chats/${chat.id}`)).chat.backgroundId).toBe(result.background.id)
      }
      expect(modelRequests.at(-1)?.stream).toBe(false)
      expect(modelRequests.at(-1)?.tools).toBeUndefined()
      expect(JSON.stringify(modelRequests.at(-1)?.messages)).toContain('- 海边')
      expect(JSON.stringify(modelRequests.at(-1)?.messages)).toContain('- 森林')
      const leaf = (await json<{ chat: ChatDTO }>(`/chats/${chat.id}`)).chat.activeLeafId
      reply = ''
      expect((await request('/backgrounds/auto', 'POST', { chatId: chat.id })).status).toBe(400)
      fail = true
      expect((await request('/backgrounds/auto', 'POST', { chatId: chat.id })).ok).toBe(false)
      expect((await json<{ chat: ChatDTO }>(`/chats/${chat.id}`)).chat.activeLeafId).toBe(leaf)
      expect((await json<{ chat: ChatDTO }>(`/chats/${chat.id}`)).chat.backgroundId).toBe(forest.id)
      await json(`/backgrounds/${imported.id}`, 'DELETE')
      await json(`/backgrounds/${forest.id}`, 'DELETE')
    } finally {
      restoreFetch?.()
      await server?.stop(true)
    }
    const large = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: 'blue' } })
      .png()
      .toBuffer()
    const generated = await saveBackground(large, { name: '生成背景', source: 'generated' })
    expect(generated).toMatchObject({ width: 3840, height: 1920, source: 'generated' })
    const rotated = await sharp({ create: { width: 80, height: 40, channels: 3, background: 'red' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()
    const rotatedBackground = await saveBackground(rotated, { name: '旋转图片', source: 'upload' })
    expect(rotatedBackground).toMatchObject({ width: 40, height: 80 })
    expect((await json<BackgroundDTO[]>('/backgrounds')).map((b) => b.id)).toEqual([rotatedBackground.id, generated.id])
  } finally {
    sqlite.close()
  }
}, 30000)
