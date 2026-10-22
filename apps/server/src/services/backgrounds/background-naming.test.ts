import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NameBackgroundsResult } from '@nobot/shared'
import sharp from 'sharp'
import { firstJsonObject } from '../../lib/json-object'

test('首个 JSON 对象兼容围栏、嵌套对象和字符串内花括号', () => {
  expect(firstJsonObject('```json\n{"name":"酒馆"}\n```')).toEqual({ name: '酒馆' })
  expect(firstJsonObject('prefix {"name":"{夜}酒馆", "nested":{"value":1}} {"other":2}')).toEqual({
    name: '{夜}酒馆',
    nested: { value: 1 },
  })
  expect(firstJsonObject('plain text')).toBeUndefined()
  expect(firstJsonObject('{"name":')).toBeUndefined()
})

test('背景 AI 命名：连接选择、看图请求、逐张容错及建议模式', async () => {
  // 数据库及设置是单例，子进程避免污染其他集成测试。
  if (!process.env.BACKGROUND_NAMING_CHILD) {
    const directory = await mkdtemp(join(tmpdir(), 'nobot-background-naming-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        env: { ...process.env, DATA_DIR: directory, BACKGROUND_NAMING_CHILD: '1' },
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
  const { initDatabase, setSetting } = await import('../../db/client')
  initDatabase()
  const { app } = await import('../../app')
  const { createApiPreset } = await import('../connections')
  const { saveProfile, setDefaultProfile } = await import('../profiles')
  const { SETTING_KEYS } = await import('../settings')
  const { saveBackground, requireBackground } = await import('./backgrounds')
  const { nameBackgrounds } = await import('./background-naming')
  const connection = createApiPreset({ name: '视觉', baseUrl: 'http://naming.test/v1', model: 'gpt-4o' })
  const png = await sharp({ create: { width: 2048, height: 1024, channels: 3, background: 'red' } })
    .png()
    .toBuffer()
  const image = await saveBackground(png, { name: '原名', source: 'upload' })
  const gif = await saveBackground(await sharp(png).gif().toBuffer(), { name: '动图', source: 'upload' })
  const video = await saveBackground(Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]), {
    name: '视频',
    source: 'upload',
  })
  let reply =
    '<think>{"name":"错误思考"}</think>```json\n{"name":"黄昏的酒馆","description":"暖色灯光下的木质酒馆"}\n```'
  const requests: {
    model: string
    messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[]
  }[] = []
  const mock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)))
        return Response.json({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  const request = (body: unknown) =>
    app.request('/api/backgrounds/ai-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  try {
    const response = await request({ ids: [image.id] })
    expect(response.status).toBe(200)
    const result = (await response.json()) as NameBackgroundsResult
    expect(result).toEqual({
      items: [{ id: image.id, name: '黄昏的酒馆', description: '暖色灯光下的木质酒馆' }],
      failed: [],
    })
    expect(requireBackground(image.id)).toMatchObject(result.items[0]!)
    const content = requests[0]!.messages[0]!.content
    expect(content[0]!.text).toContain('Write in Chinese.')
    expect(requests[0]!.model).toBe('gpt-4o')
    const bytes = Buffer.from(content[1]!.image_url!.url.split(',')[1]!, 'base64')
    expect(await sharp(bytes).metadata()).toMatchObject({ width: 1024, height: 512, format: 'jpeg' })

    reply = JSON.stringify({ name: '新建议', description: '😀'.repeat(60) })
    const suggestion = await nameBackgrounds({ ids: [image.id], apply: false })
    expect(suggestion.items[0]?.name).toBe('新建议')
    expect(Array.from(suggestion.items[0]!.description)).toHaveLength(40)
    expect(requireBackground(image.id).name).toBe('黄昏的酒馆')

    const mixed = await nameBackgrounds({ ids: [video.id, gif.id] })
    expect(mixed.failed).toEqual([{ id: video.id, error: '动态视频背景暂不支持 AI 命名' }])
    expect(mixed.items[0]?.id).toBe(gif.id)
    expect(requireBackground(gif.id).description.length).toBeLessThanOrEqual(200)

    reply = 'not JSON'
    expect((await nameBackgrounds({ ids: [image.id] })).failed).toEqual([
      { id: image.id, error: '模型返回的 JSON 无效' },
    ])
    reply = '{"name":"  "}'
    expect((await nameBackgrounds({ ids: [image.id] })).failed[0]?.error).toBe('模型返回的名字为空')
    expect(requireBackground(image.id).name).toBe('黄昏的酒馆')

    const profile = saveProfile({ name: '全局配置', apiPresetId: connection.id, model: 'gpt-4.1-mini' })
    setDefaultProfile(profile.id)
    reply = '{"name":"全局模型"}'
    await nameBackgrounds({ ids: [image.id], apply: false })
    expect(requests.at(-1)?.model).toBe('gpt-4.1-mini')

    // 未配置 caption 时跟随全局配置，配置后即使扩展未启用也优先采用。
    setSetting(SETTING_KEYS.extensionSettings('caption'), { connectionId: connection.id, model: 'gpt-4.1' })
    reply = '{"name":"覆盖模型"}'
    await nameBackgrounds({ ids: [image.id] })
    expect(requests.at(-1)?.model).toBe('gpt-4.1')
    setSetting(SETTING_KEYS.app, { language: 'en' })
    await nameBackgrounds({ ids: [image.id], apply: false })
    expect(requests.at(-1)?.messages[0]?.content[0]?.text).toContain('Write in English.')
    setSetting(SETTING_KEYS.app, { language: 'zh' })
    setSetting(SETTING_KEYS.extensionSettings('caption'), { connectionId: connection.id, model: 'text-only' })
    const count = requests.length
    const noVision = await request({ ids: [image.id, video.id] })
    expect(noVision.status).toBe(400)
    expect(await noVision.json()).toMatchObject({ error: { code: 'NO_VISION' } })
    expect(requests).toHaveLength(count)
    expect((await request({ ids: [] })).status).toBe(400)
    expect((await request({ ids: Array(51).fill(image.id) })).status).toBe(400)
  } finally {
    mock.mockRestore()
  }
})
