import { expect, spyOn, test } from 'bun:test'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { BuildInput } from '@ai-parter/core'
import type { CharacterDTO, ChatDTO, ExtensionDTO, MessageDTO, PromptPresetDTO } from '@ai-parter/shared'
import { readSSE } from './helpers/sse'

// 数据库与环境配置是模块单例，整个集成场景在子进程执行，避免影响已有测试。
test('扩展 v2：manifest、旧入口、接口、资源、存储、钩子与生成事件', async () => {
  if (!process.env.EXTENSION_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', 'apps/server/test/extensions.test.ts'], {
      env: { ...process.env, EXTENSION_TEST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timeout = setTimeout(() => child.kill(), 20000)
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, `${out}\n${err}`).toBe(0)
    } finally {
      clearTimeout(timeout)
    }
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'ai-parter-extensions-'))
  const previous = process.env.DATA_DIR
  process.env.DATA_DIR = directory
  let sqlite: typeof import('../src/db/client').sqlite | undefined
  // 上游模型在 fetch 边界模拟，验证真实生成服务和 SSE，但不依赖监听端口。
  const modelFetch = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const body = JSON.parse(String(init?.body)) as { messages: { role: string }[] }
        const done = body.messages.some((message) => message.role === 'tool')
        return Response.json({
          choices: [
            {
              message: done
                ? { role: 'assistant', content: '结束' }
                : {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                      { id: 'call-1', type: 'function', function: { name: 'fixture_tool', arguments: '{}' } },
                    ],
                  },
              finish_reason: done ? 'stop' : 'tool_calls',
            },
          ],
        })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  try {
    const root = join(directory, 'extensions')
    const fixture = join(root, 'b-fixture')
    await mkdir(fixture, { recursive: true })
    const manifest = {
      id: 'fixture',
      name: '测试扩展',
      version: '2.0',
      description: '完整测试',
      author: '测试作者',
      server: 'server.ts',
      client: 'client.js',
      style: 'style.css',
    }
    await Bun.write(join(fixture, 'manifest.json'), JSON.stringify(manifest))
    await Bun.write(join(fixture, 'client.js'), 'export default function activate() {}')
    await Bun.write(join(fixture, 'style.css'), '.fixture { color: red }')
    await Bun.write(join(fixture, 'secret.txt'), '不得返回这个文件')
    await Bun.write(
      join(fixture, 'server.ts'),
      `
      export default {
        id: 'fixture', name: '测试扩展', version: '2.0', description: '',
        defaultSettings: { greeting: '你好' },
        macros: { hello: (_arg, ctx) => String(ctx.settings.greeting) },
        tools: [{ name: 'fixture_tool', description: '测试工具', parameters: { type: 'object', properties: {} }, run: () => ({ content: '工具结果' }) }],
        routes(app, ctx) {
          ctx.storage.set('routesCalls', (ctx.storage.get('routesCalls') ?? 0) + 1)
          app.get('/stats', (c) => c.json({ events: ctx.storage.get('events') ?? [], greeting: ctx.settings.greeting, calls: ctx.storage.get('routesCalls') }))
          app.post('/storage', async (c) => { ctx.storage.set('value', await c.req.json()); return c.json({ ok: true }) })
          app.get('/storage', (c) => c.json({ value: ctx.storage.get('value') ?? null }))
          app.delete('/storage', (c) => { ctx.storage.delete('value'); return c.json({ ok: true }) })
          app.get('/echo', (c) => c.json({ query: c.req.query('value') }))
          app.post('/echo', async (c) => c.json({ body: await c.req.json(), header: c.req.header('x-test') }))
          app.get('/failure', () => { throw new Error('模拟接口异常') })
        },
        hooks: {
          beforePrompt: (input) => ({ ...input, now: 123 }),
          onEvent: (event, ctx) => {
            const events = ctx.storage.get('events') ?? []
            ctx.storage.set('events', [...events, event])
          }
        }
      }
    `,
    )
    const legacy = join(root, 'a-legacy')
    await mkdir(legacy)
    await Bun.write(
      join(legacy, 'index.ts'),
      "export default { id: 'legacy', name: '旧式扩展', version: '1', description: '' }",
    )
    const legacyJs = join(root, 'c-legacy-js')
    await mkdir(legacyJs)
    await Bun.write(
      join(legacyJs, 'index.js'),
      "export default { id: 'legacy-js', name: '旧式 JS', version: '1', description: '' }",
    )
    for (const [name, value] of Object.entries({
      'invalid-id': { ...manifest, id: '../escape' },
      'missing-field': { id: 'missing-field', name: '缺字段' },
      'unsafe-path': { ...manifest, id: 'unsafe-path', server: '../outside.ts' },
      'unsafe-client': { ...manifest, id: 'unsafe-client', server: undefined, client: '../outside.ts' },
      'unsafe-style': { ...manifest, id: 'unsafe-style', server: undefined, client: undefined, style: 'escape.css' },
      'duplicate-id': { ...manifest, id: 'regex', server: undefined, client: undefined, style: undefined },
    })) {
      const folder = join(root, `z-${name}`)
      await mkdir(folder)
      await Bun.write(join(folder, 'manifest.json'), JSON.stringify(value))
      // manifest 无效时不能回退到能运行的旧入口。
      await Bun.write(join(folder, 'index.ts'), "export default { id: 'unexpected', name: '不应加载' }")
      if (name === 'unsafe-style') {
        await Bun.write(join(directory, 'outside.css'), '机密')
        await symlink(join(directory, 'outside.css'), join(folder, 'escape.css'))
      }
    }
    // 使用真实示例，检查复制后的相对导入路径仍能加载。
    await cp(resolve('examples/extensions/hello-world'), join(root, 'hello-world'), { recursive: true })
    await (await import('../src/bootstrap')).bootstrap()
    sqlite = (await import('../src/db/client')).sqlite
    const { app } = await import('../src/app')
    const registry = await import('../src/extensions/registry')
    const request = (path: string, method = 'GET', data?: unknown) =>
      app.request(`/api${path}`, {
        method,
        ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
      })
    async function json<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
      const response = await request(path, method, data)
      const value = await response.json()
      expect(response.status, JSON.stringify(value)).toBe(200)
      return value as T
    }
    let list = await json<ExtensionDTO[]>('/extensions')
    expect(list.slice(0, 8).map((x) => x.id)).toEqual([
      'regex',
      'image-gen',
      'summary',
      'caption',
      'legacy',
      'fixture',
      'legacy-js',
      'hello-world',
    ])
    const item = list.find((x) => x.id === 'fixture')!
    expect(item).toMatchObject({
      id: 'fixture',
      name: '测试扩展',
      version: '2.0',
      description: '完整测试',
      author: '测试作者',
      client: { script: true, style: true },
      hasRoutes: true,
      enabled: false,
      source: 'local',
      settings: { greeting: '你好' },
    })
    expect(item.provides).toEqual({ macros: ['hello'], tools: ['fixture_tool'], hooks: ['beforePrompt', 'onEvent'] })
    expect(list.filter((x) => x.loadError)).toHaveLength(6)
    expect(list.some((x) => x.id === 'unexpected')).toBe(false)
    expect(list.find((x) => x.id === 'legacy')?.client).toEqual({ script: false, style: false })
    expect(list.find((x) => x.id === 'hello-world')?.loadError).toBeUndefined()
    const disabled = await request('/ext/fixture/stats')
    expect(disabled.status).toBe(404)
    expect(await disabled.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
    expect((await request('/extensions/fixture/client.js')).status).toBe(404)
    await json('/extensions/fixture', 'PATCH', { enabled: true })
    expect(await json('/ext/fixture/echo?value=中文')).toEqual({ query: '中文' })
    const echo = await app.request('/api/ext/fixture/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test': 'header' },
      body: JSON.stringify({ value: '请求体' }),
    })
    expect(await echo.json()).toEqual({ body: { value: '请求体' }, header: 'header' })
    const failedRoute = await request('/ext/fixture/failure')
    expect(failedRoute.status).toBe(500)
    expect(await failedRoute.json()).toMatchObject({
      error: { code: 'INTERNAL', message: '服务器内部错误：模拟接口异常' },
    })
    expect((await request('/ext/missing/stats')).status).toBe(404)
    expect((await request('/ext/fixture/missing')).status).toBe(404)
    for (const [file, content, type] of [
      ['client.js', 'export default function activate() {}', 'text/javascript'],
      ['style.css', '.fixture { color: red }', 'text/css'],
    ]) {
      const response = await request(`/extensions/fixture/${file}`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(content!)
      expect(response.headers.get('Content-Type')).toBe(type!)
      expect(response.headers.get('Cache-Control')).toBe('no-cache')
    }
    for (const path of [
      '/extensions/fixture/secret.txt',
      '/extensions/fixture/%2e%2e%2fsecret.txt',
      '/extensions/fixture/client.js/secret.txt',
      '/extensions/fixture/%2e%2e%2fclient.js',
    ]) {
      expect((await request(path)).status).toBe(404)
    }
    await json('/ext/fixture/storage', 'POST', { nested: [1, '中文'] })
    expect(await json('/ext/fixture/storage')).toEqual({ value: { nested: [1, '中文'] } })
    const { getSetting } = await import('../src/db/client')
    expect(getSetting('extdata:fixture:value')).toEqual({ nested: [1, '中文'] })
    await json('/ext/fixture/storage', 'DELETE')
    expect(await json('/ext/fixture/storage')).toEqual({ value: null })
    expect(getSetting('extdata:fixture:value')).toBeUndefined()
    await json('/extensions/fixture', 'PATCH', { settings: { greeting: '欢迎' } })
    expect(registry.collectMacros('chat').hello?.('')).toBe('欢迎')
    const input = { chat: { id: 'chat' }, now: 999 } as BuildInput
    expect(registry.runBeforePrompt(input).now).toBe(123)
    expect(await json('/ext/fixture/stats')).toMatchObject({ greeting: '欢迎', calls: 1 })
    const character = await json<CharacterDTO>('/characters', 'POST', {
      name: '事件测试',
      description: '{{hello}}',
      firstMes: '开场',
    })
    const chat = await json<ChatDTO>('/chats', 'POST', { characterId: character.id })
    await json('/connections', 'POST', {
      name: '模拟连接',
      baseUrl: 'http://extension-model.invalid/v1',
      apiKey: 'test',
      model: 'mock-one',
    })
    const preset = (await json<PromptPresetDTO[]>('/presets'))[0]!
    await json(`/presets/${preset.id}`, 'PATCH', {
      data: { ...preset.data, samplers: { ...preset.data.samplers, functionCalling: true, stream: false } },
    })
    const generated = await request(`/chats/${chat.id}/generate`, 'POST', { mode: 'send', text: '用户消息' })
    const events = await readSSE(generated)
    expect(events.at(-1)?.type).toBe('complete')
    expect(events.some((e) => e.type === 'error')).toBe(false)
    const stats = await json<{ events: { type: string; chatId?: string; message?: MessageDTO }[] }>(
      '/ext/fixture/stats',
    )
    expect(stats.events[0]).toMatchObject({ type: 'chat:created', chatId: chat.id })
    expect(stats.events.filter((e) => e.type === 'message:saved').map((e) => e.message?.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(stats.events.at(-1)).toEqual({ type: 'generation:complete', chatId: chat.id })
    // 再次请求和切换设置不会重新执行 routes。
    expect(await json('/ext/fixture/stats')).toMatchObject({ calls: 1 })
    await json('/extensions/fixture', 'PATCH', { enabled: false })
    expect((await request('/ext/fixture/stats')).status).toBe(404)
    expect(registry.collectMacros('chat').hello).toBeUndefined()
    expect(registry.runBeforePrompt(input)).toBe(input)
    expect((await request('/extensions/fixture/style.css')).status).toBe(404)
    await json('/extensions/fixture', 'PATCH', { enabled: true })
    expect(await json('/ext/fixture/stats')).toMatchObject({ calls: 1 })
    list = await json<ExtensionDTO[]>('/extensions')
    expect(list.find((x) => x.id === 'fixture')?.enabled).toBe(true)
  } finally {
    modelFetch.mockRestore()
    sqlite?.close()
    if (previous === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previous
    await rm(directory, { recursive: true, force: true })
  }
}, 25000)
