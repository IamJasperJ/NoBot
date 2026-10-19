import { expect, type Mock, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackgroundDTO, ChatDTO, ChatPage, PlayPresetDTO, PromptPreview } from '@nobot/shared'
import { mockLlm } from './helpers/mockLlm'

// 环境和数据库是单例，独立进程防止与其他集成测试串库。
test('BG-SCOPE：字段、范围、清单、自动选择、命名、固定和删除会话', async () => {
  if (!process.env.BG_SCOPE_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', 'apps/server/test/background-scope.test.ts'], {
      env: { ...process.env, BG_SCOPE_TEST_CHILD: '1', MOCK_LLM_FETCH: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'nobot-bg-scope-'))
  process.env.DATA_DIR = directory
  const { paths } = await import('../src/env')
  paths.db = ':memory:'
  await (await import('../src/bootstrap')).bootstrap()
  const { sqlite } = await import('../src/db/client')
  const { app } = await import('../src/app')
  const { saveBackground, backgroundsForChat, requireBackground } = await import('../src/services/backgrounds')
  const { computeStage } = await import('../src/services/stage')
  const { createExtensionHost } = await import('../src/extensions/host')
  const { updateExtension } = await import('../src/extensions/registry')
  const { nameBackground } = await import('../src/extensions/builtin/image-gen/pipeline')
  const { parseSettings } = await import('../src/extensions/builtin/image-gen/settings')
  const model = mockLlm()
  const png = new Uint8Array(await Bun.file('fixtures/images/test.png').arrayBuffer())
  const textFetch = (globalThis.fetch as Mock<typeof fetch>).getMockImplementation()!
  const imageFetch = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init)
        if (request.url.endsWith('/images/generations')) {
          return Response.json({ data: [{ b64_json: Buffer.from(png).toString('base64') }] })
        }
        if (request.url.endsWith('/import.png')) return new Response(png)
        return textFetch(input, init)
      },
      { preconnect: fetch.preconnect },
    ),
  )
  const request = (path: string, method = 'GET', body?: unknown) =>
    app.request(`/api${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
  async function json<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await request(path, method, body)
    const value: unknown = await response.json()
    expect(response.status, JSON.stringify(value)).toBe(200)
    return value as T
  }
  const preview = async (chatId: string) => {
    const result = await json<PromptPreview>(`/chats/${chatId}/prompt-preview`, 'POST', {})
    return result.report.segments.find((segment) => segment.source === 'stage')!.content
  }
  const scene = (chatId: string, bg: string) =>
    computeStage(chatId, [
      {
        meta: { stage: { v: 1, beats: [], ops: [{ op: 'scene', bg }] } },
      },
    ])?.scene.backgroundId
  try {
    const actor = await json<{ id: string }>('/characters', 'POST', {
      name: '画师',
      first_mes: '<scene bg="雨夜小巷" />',
    })
    const a = await json<ChatDTO>('/chats', 'POST', { characterId: actor.id })
    const b = await json<ChatDTO>('/chats', 'POST', { characterId: actor.id })
    const gal = (await json<PlayPresetDTO[]>('/play-presets')).find((preset) => preset.name === 'Galgame')!
    const connection = await json<{ id: string }>('/connections', 'POST', {
      name: '命名连接',
      baseUrl: model.url,
      model: 'mock-one',
      apiKey: '',
    })
    for (const chat of [a, b])
      await json(`/chats/${chat.id}`, 'PATCH', { playPresetId: gal.id, apiPresetId: connection.id })
    const form = new FormData()
    form.set('file', new File([png], '公共海边.png'))
    const uploaded = await app.request('/api/backgrounds', { method: 'POST', body: form })
    expect(uploaded.status).toBe(200)
    const publicBg = (await uploaded.json()) as BackgroundDTO
    expect(publicBg).toMatchObject({ chatId: null, description: '' })
    const imported = await json<BackgroundDTO>('/backgrounds/import-url', 'POST', { url: 'http://mock/import.png' })
    expect(imported).toMatchObject({ chatId: null, description: '' })
    expect(await json(`/backgrounds/${publicBg.id}`, 'PATCH', { name: '公共海滩' })).toMatchObject({
      name: '公共海滩',
      description: '',
    })
    const longDescription = '🌙'.repeat(41)
    expect(await json(`/backgrounds/${publicBg.id}`, 'PATCH', { description: longDescription })).toMatchObject({
      name: '公共海滩',
      description: longDescription,
    })
    expect((await request(`/backgrounds/${publicBg.id}`, 'PATCH', {})).status).toBe(400)
    expect((await request(`/backgrounds/${publicBg.id}`, 'PATCH', { unknown: true })).status).toBe(400)
    const privateBg = await saveBackground(png, {
      name: '专属山谷',
      source: 'generated',
      chatId: a.id,
      description: '夕阳照亮山谷',
    })
    expect(backgroundsForChat(b.id).some((bg) => bg.id === privateBg.id)).toBe(false)
    expect(scene(a.id, privateBg.name)).toBe(privateBg.id)
    expect(scene(b.id, privateBg.name)).toBeNull()
    expect(scene(b.id, '专属山')).toBeNull()
    expect(scene(a.id, '公共海滩')).toBe(publicBg.id)
    expect(scene(b.id, '公共海滩')).toBe(publicBg.id)
    expect(scene(a.id, '专属山')).toBe(privateBg.id)
    expect(scene(a.id, '专属山古')).toBeNull()
    const aInstructions = await preview(a.id)
    const bInstructions = await preview(b.id)
    expect(aInstructions).toContain('Available backgrounds: 专属山谷')
    expect(bInstructions).not.toContain('专属山谷')
    expect(bInstructions).toContain('公共海滩')
    expect(bInstructions).not.toContain(longDescription)
    expect(bInstructions).toContain(imported.name)
    expect(bInstructions).not.toContain(`${imported.name}（`)
    model.setScript(() => ({ text: privateBg.name }))
    const picked = await json<{ background: BackgroundDTO }>('/backgrounds/auto', 'POST', { chatId: b.id })
    expect(picked.background.id).not.toBe(privateBg.id)
    const autoInstruction = model.requests
      .at(-1)!
      .messages.map((message) => message.content)
      .join('\n')
    expect(autoInstruction).not.toContain(privateBg.name)
    expect(autoInstruction).toContain(`- 公共海滩：${longDescription}`)
    model.setScript(() => ({ text: privateBg.name }))
    expect(
      (await json<{ background: BackgroundDTO }>('/backgrounds/auto', 'POST', { chatId: a.id })).background.id,
    ).toBe(privateBg.id)
    expect(await json(`/backgrounds/${privateBg.id}`, 'PATCH', { chatId: null })).toMatchObject({
      chatId: null,
      description: privateBg.description,
      name: privateBg.name,
    })
    expect(scene(b.id, privateBg.name)).toBe(privateBg.id)
    expect(a.backgroundPinned).toBe(false)
    await json(`/chats/${a.id}`, 'PATCH', { backgroundPinned: true })
    expect((await json<ChatPage>(`/chats/${a.id}`)).chat.backgroundPinned).toBe(true)
    await json(`/chats/${a.id}`, 'PATCH', { backgroundPinned: false })
    expect((await json<ChatPage>(`/chats/${a.id}`)).chat.backgroundPinned).toBe(false)

    const settings = {
      openaiBaseUrl: model.url,
      async: false,
      promptConnectionId: connection.id,
      promptModel: 'mock-two',
    }
    updateExtension('image-gen', { settings })
    const generate = () =>
      json<{ background: BackgroundDTO }>('/ext/image-gen/generate', 'POST', {
        chatId: a.id,
        mode: 'background',
        prompt: 'rainy alley at night',
      })
    model.setScript(() => ({ text: '前言\n```json\n{"name":"模型忽略名","description":"雨水映照着灯光"}\n```' }))
    const stageBg = (await generate()).background
    expect(stageBg).toMatchObject({ name: '雨夜小巷', description: '雨水映照着灯光', chatId: a.id })
    expect((await json<ChatPage>(`/chats/${a.id}`)).stage?.scene.backgroundId).toBe(stageBg.id)
    expect((await json<ChatPage>(`/chats/${a.id}`)).chat.backgroundId).toBe(stageBg.id)
    const namingRequest = model.requests.at(-1)!
    expect(namingRequest.model).toBe('mock-two')
    expect(namingRequest.max_tokens).not.toBe(120)
    expect(namingRequest.messages).toHaveLength(1)
    expect(namingRequest.messages[0]?.role).toBe('user')
    expect(namingRequest.messages.some((message) => message.role === 'assistant')).toBe(false)
    expect(JSON.stringify(namingRequest.messages)).toContain('rainy alley at night')
    model.setScript(() => ({ text: '{"name":"晨雾森林","description":"晨光穿过薄雾和树梢"}' }))
    expect((await generate()).background).toMatchObject({
      name: '晨雾森林',
      description: '晨光穿过薄雾和树梢',
      chatId: a.id,
    })
    model.setScript(() => ({ text: '```json\n{"name":"暖光书房","description":"墙上挂着{山水}画"}\n```' }))
    expect((await generate()).background).toMatchObject({ name: '暖光书房', description: '墙上挂着{山水}画' })
    model.setScript(() => ({ text: '乱码' }))
    const fallback = (await generate()).background
    expect(fallback.name).toBe('rainy alley at night')
    expect(fallback.description).toBe('')
    const host = createExtensionHost(() => {})
    const log = spyOn(host, 'log')
    const context = { host }
    for (const reply of ['乱码', '{"name":" "}', '{无效}']) {
      model.setScript(() => ({ text: reply }))
      log.mockClear()
      expect((await nameBackground(context, a.id, parseSettings(settings), 'forest', '画师')).name).toBe('forest')
      expect(log).toHaveBeenCalledTimes(1)
      expect(log.mock.calls[0]![0]).toMatchObject({
        kind: 'image',
        status: 'error',
        summary: expect.stringContaining('背景起名失败：'),
      })
    }
    await json<ChatPage>(`/chats/${b.id}`)
    model.setScript(() => ({ status: 500, error: '模拟命名失败' }))
    expect(await nameBackground(context, b.id, parseSettings(settings), 'alley', '画师')).toEqual({
      name: '雨夜小巷',
      description: '',
    })
    log.mockRestore()

    const globalBg = await saveBackground(png, { name: '全局保留', source: 'generated', chatId: a.id })
    const otherBg = await saveBackground(png, { name: '其他会话保留', source: 'generated', chatId: a.id })
    await json('/backgrounds/settings', 'PUT', { globalId: globalBg.id })
    await json(`/chats/${b.id}`, 'PATCH', { backgroundId: otherBg.id })
    await json(`/chats/${a.id}`, 'DELETE')
    for (const bg of [stageBg, fallback]) {
      expect(() => requireBackground(bg.id)).toThrow()
      expect(await Bun.file(join(paths.backgrounds, `${bg.id}.webp`)).exists()).toBe(false)
      expect(await Bun.file(join(paths.backgrounds, `${bg.id}.thumb.webp`)).exists()).toBe(false)
    }
    for (const bg of [globalBg, otherBg]) {
      expect(requireBackground(bg.id).chatId).toBeNull()
      expect(await Bun.file(join(paths.backgrounds, `${bg.id}.webp`)).exists()).toBe(true)
    }
    expect(requireBackground(privateBg.id).chatId).toBeNull()
    expect(await json('/backgrounds/settings')).toEqual({ globalId: globalBg.id })
    expect((await json<ChatPage>(`/chats/${b.id}`)).chat.backgroundId).toBe(otherBg.id)
    // 用非空目录模拟文件清理失败，验证接口仍成功且保留一条错误日志。
    const failed = await saveBackground(png, { name: '清理失败', source: 'generated', chatId: b.id })
    const failedFile = join(paths.backgrounds, `${failed.id}.webp`)
    await rm(failedFile)
    await mkdir(failedFile)
    await Bun.write(join(failedFile, '占位'), '阻止删除')
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await json(`/chats/${b.id}`, 'DELETE')
      expect(errorLog).toHaveBeenCalled()
    } finally {
      errorLog.mockRestore()
    }
  } finally {
    imageFetch.mockRestore()
    await model.stop()
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
