import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('关闭的扩展仅放行候选 POST，图片说明候选遵循草稿和会话连接', async () => {
  // 注册表、数据库和 fetch 都是全局状态，使用独立子进程避免污染其他测试。
  if (!process.env.EXT_OPTIONS_CHILD) {
    const directory = await mkdtemp(join(tmpdir(), 'extension-options-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', 'apps/server/test/extension-options.test.ts'], {
        env: { ...process.env, DATA_DIR: directory, EXT_OPTIONS_CHILD: '1' },
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
  const { sqlite } = await import('../src/db/client')
  const { registerBuiltinExtension, updateExtension, listExtensions } = await import('../src/extensions/registry')
  const { createApiPreset } = await import('../src/services/connections')
  const { createCharacter } = await import('../src/services/characters')
  const { createChat, updateChat } = await import('../src/services/chats')
  const { saveProfile } = await import('../src/services/profiles')
  const { setAppSettings } = await import('../src/services/settings')
  const calls: { url: string; headers: Headers }[] = []
  const mocked = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers) })
        return Response.json({ data: [{ id: 'vision-model' }] })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  const request = (id: string, path: string, method = 'POST', body: unknown = {}) =>
    app.request(`/api/ext/${id}/${path}`, {
      method,
      ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
  async function options(id: string, path: string, body: unknown = {}) {
    const response = await request(id, path, 'POST', body)
    expect(response.status).toBe(200)
    return (await response.json()) as { options: { value: string; label: string }[] }
  }
  try {
    registerBuiltinExtension({
      id: 'options-test',
      name: '候选测试',
      description: '',
      version: '1',
      enabledByDefault: false,
      settingsSchema: [
        { key: 'model', label: '模型', type: 'string', optionsSource: '/models' },
        {
          key: 'items',
          label: '列表',
          type: 'list',
          itemFields: [
            {
              key: 'nested',
              label: '嵌套',
              type: 'list',
              itemFields: [{ key: 'model', label: '模型', type: 'string', optionsSource: '/openai/models' }],
            },
          ],
        },
      ],
      routes(app) {
        app.all('*', (c) => c.json({ options: [] }))
      },
    })
    for (const path of ['models', 'openai/models']) await options('options-test', path)
    for (const [path, method] of [
      ['models', 'GET'],
      ['models', 'PUT'],
      ['models/extra', 'POST'],
      ['models/', 'POST'],
      ['run', 'POST'],
      ['other/models', 'POST'],
    ]) {
      expect((await request('options-test', path!, method)).status).toBe(404)
    }
    expect((await request('missing-extension', 'models')).status).toBe(404)
    registerBuiltinExtension({ id: 'no-routes', name: '无路由', description: '', version: '1' })
    expect((await request('no-routes', 'models')).status).toBe(404)

    setAppSettings({ language: 'zh' })
    const saved = createApiPreset({ name: '保存连接', baseUrl: 'http://saved/v1', model: 'saved' })
    const draft = createApiPreset({
      name: '草稿连接',
      baseUrl: 'http://draft/v1',
      model: 'draft',
      apiKey: 'draft-secret',
      headers: { 'X-Candidate': 'draft' },
    })
    const chat = createChat({ characterId: createCharacter({ name: '角色' }).id })
    const profile = saveProfile({ name: '会话配置组', apiPresetId: draft.id })
    updateChat(chat.id, { profileId: profile.id })
    updateExtension('caption', { enabled: false, settings: { connectionId: saved.id } })
    const connections = await options('caption', 'connections')
    expect(connections.options).toEqual([
      { value: '', label: '跟随当前会话的连接' },
      { value: saved.id, label: saved.name },
      { value: draft.id, label: draft.name },
    ])
    expect(await options('caption', 'models', { settings: { connectionId: draft.id } })).toEqual({
      options: [{ value: 'vision-model', label: 'vision-model' }],
    })
    expect(calls.at(-1)?.url).toBe('http://draft/v1/models')
    expect(calls.at(-1)?.headers.get('Authorization')).toBe('Bearer draft-secret')
    expect(calls.at(-1)?.headers.get('X-Candidate')).toBe('draft')
    await options('caption', 'models')
    expect(calls.at(-1)?.url).toBe('http://saved/v1/models')
    await options('caption', 'models', { chatId: chat.id, settings: { connectionId: '' } })
    expect(calls.at(-1)?.url).toBe('http://draft/v1/models')
    await options('caption', 'models', { settings: { connectionId: '' } })
    expect(calls.at(-1)?.url).toBe('http://saved/v1/models')
    expect((await request('caption', 'attachments/unused')).status).toBe(404)
    updateExtension('summary', { enabled: false })
    await options('summary', 'connections')
    expect((await request('summary', 'run')).status).toBe(404)
    updateExtension('image-gen', { enabled: false })
    await options('image-gen', 'openai/models', { settings: { openaiConnectionId: draft.id } })
    expect(calls.at(-1)?.url).toBe('http://draft/v1/models')

    setAppSettings({ language: 'en' })
    expect((await options('caption', 'connections')).options[0]?.label).toBe('Follow the current chat connection')
    expect(listExtensions().find((extension) => extension.id === 'caption')?.settingsSchema).toContainEqual({
      key: 'model',
      label: 'Vision model',
      type: 'string',
      optionsSource: 'models',
      hint: "Leave blank to use the connection's model",
    })
    updateExtension('options-test', { enabled: true })
    expect((await request('options-test', 'run')).status).toBe(200)
  } finally {
    mocked.mockRestore()
    sqlite.close()
  }
}, 15000)
