import { expect, mock, spyOn, test } from 'bun:test'
import type { ExtensionDTO, MessageDTO } from '@nobot/shared'
import { QueryClient } from '@tanstack/react-query'
import { getCommand } from '../commands/registry'
import type { ClientExtensionAPI } from './types'

// 模块 mock 和极小 DOM 仅存在于子进程，避免污染其他前端测试。
test('前端扩展：注册排序、页面、事件、变换、失败隔离与热启停清理', async () => {
  if (!process.env.CLIENT_EXTENSION_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', 'apps/web/src/extensions/runtime.test.tsx'], {
      env: { ...process.env, CLIENT_EXTENSION_TEST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, `${out}\n${err}`).toBe(0)
    return
  }
  const links = new Set<unknown>()
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => {
        const link = { rel: '', href: '', remove: () => links.delete(link) }
        return link
      },
      head: { append: (link: unknown) => links.add(link) },
    },
  })
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'http://localhost' } })
  let activations = 0
  let cleanups = 0
  let events = 0
  let extensionAPI: ClientExtensionAPI | undefined
  mock.module('/api/extensions/client-one/client.js?v=1', () => ({
    default: (api: ClientExtensionAPI) => {
      extensionAPI = api
      activations++
      api.registerSlot('chat.header.actions', { id: 'late', order: 200, render: () => '后' })
      api.registerSlot('chat.header.actions', { id: 'early', order: 10, render: () => '前' })
      api.registerCommand({ name: 'runtime-owned', description: '测试', args: [], run: async () => '' })
      api.registerPage({ id: 'page', label: '测试页面', icon: '👋', render: () => '页面正文' })
      api.registerMessageTransform((text) => text.replaceAll('[[闪光]]', '✨'))
      api.on('generation:complete', () => {
        events++
      })
      return () => {
        cleanups++
      }
    },
  }))
  mock.module('/api/extensions/client-one/client.js?v=2', () => ({
    default: (api: ClientExtensionAPI) => {
      expect(cleanups).toBe(2)
      expect(getCommand('runtime-owned')).toBeUndefined()
      expect(api.id).toBe('client-one')
      activations++
      api.registerCommand({ name: 'runtime-new', description: '新版', args: [], run: async () => '' })
      api.registerPage({ id: 'new-page', label: '新版页面', icon: '', render: () => '新版' })
      api.registerSlot('sidebar.footer', { id: 'new-slot', render: () => '新版' })
      return () => {
        cleanups++
      }
    },
  }))
  mock.module('/api/extensions/client-broken/client.js?v=1', () => ({
    default: (api: ClientExtensionAPI) => {
      api.registerSlot('sidebar.footer', { id: 'partial', render: () => '不能残留' })
      throw new Error('模拟激活失败')
    },
  }))
  mock.module('/api/extensions/client-two/client.js?v=1', () => ({
    default: (api: ClientExtensionAPI) => {
      api.registerMessageTransform((text) => `${text}！`)
      api.registerMessageTransform(() => {
        throw new Error('模拟变换失败')
      })
    },
  }))
  const dto = (id: string): ExtensionDTO => ({
    id,
    name: id,
    description: '',
    author: '',
    version: '1',
    source: 'local',
    enabled: true,
    client: { script: true, style: true },
    permissions: null,
    detected: { server: false, client: false, routes: false, tools: false, hooks: false },
    permissionWarnings: [],
    needsApproval: false,
    git: null,
    revision: '1',
    hasRoutes: true,
    settingsSchema: [],
    settings: { greeting: '你好' },
    provides: { macros: [], hooks: [], tools: [] },
  })
  const extensions = [dto('client-one'), dto('client-broken'), dto('client-two')]
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input)
        if (url === '/api/extensions') return Response.json(extensions)
        if (url === '/api/extensions/client-one' && init?.method === 'PATCH') {
          extensions[0]!.settings = JSON.parse(String(init.body)).settings
          return Response.json(extensions[0])
        }
        return Response.json({ ok: true })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  const qc = new QueryClient()
  try {
    const runtime = await import('./runtime')
    const { useUi } = await import('../stores/ui')
    const { useToasts } = await import('../stores/toast')
    await Promise.all([runtime.loadExtensions(qc), runtime.loadExtensions(qc)])
    expect(activations).toBe(1)
    expect(links.size).toBe(2)
    expect(useToasts.getState().toasts.some((t) => t.message.includes('模拟激活失败'))).toBe(true)
    expect(runtime.useExtensionsRuntime.getState().slots).toHaveLength(2)
    const slots = runtime.useExtensionsRuntime.getState().slots
    expect(slots.sort((a, b) => a.order - b.order).map((entry) => entry.render({ chatId: 'chat' } as never))).toEqual([
      '前',
      '后',
    ])
    expect(runtime.useExtensionsRuntime.getState().pages[0]?.render()).toBe('页面正文')
    const message = { content: '[[闪光]]' } as MessageDTO
    expect(runtime.transformMessage(message.content, message, runtime.useExtensionsRuntime.getState().transforms)).toBe(
      '✨！',
    )
    runtime.emitClientEvent({ type: 'generation:complete', chatId: 'chat' })
    expect(events).toBe(1)
    expect(await extensionAPI!.getSettings()).toEqual({ greeting: '你好' })
    await extensionAPI!.saveSettings({ greeting: '欢迎' })
    expect(await extensionAPI!.getSettings()).toEqual({ greeting: '欢迎' })
    await extensionAPI!.fetchServer('/stats')
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe('http://localhost/api/ext/client-one/stats')
    await expect(extensionAPI!.fetchServer('../outside')).rejects.toThrow('路径不合法')
    extensionAPI!.openView('ext:client-one:page')
    expect(useUi.getState()).toMatchObject({
      view: 'extensions',
      focusId: 'client-one',
      extensionPageId: 'page',
      panelOpen: true,
      sidebarOpen: true,
    })
    extensions[0]!.enabled = false
    await runtime.loadExtensions(qc, 'client-one')
    expect(cleanups).toBe(1)
    expect(runtime.useExtensionsRuntime.getState().pages).toHaveLength(0)
    expect(runtime.useExtensionsRuntime.getState().slots).toHaveLength(0)
    expect(links.size).toBe(1)
    expect(useUi.getState()).toMatchObject({ view: 'extensions', focusId: 'client-one', extensionPageId: null })
    runtime.emitClientEvent({ type: 'generation:complete', chatId: 'chat' })
    expect(events).toBe(1)
    // 已停用的闭包晚到时也不能再次注册。
    extensionAPI!.registerPage({ id: 'stale', label: '旧闭包', icon: '', render: () => '' })
    expect(runtime.useExtensionsRuntime.getState().pages).toHaveLength(0)
    extensions[0]!.enabled = true
    await runtime.loadExtensions(qc, 'client-one')
    expect(activations).toBe(2)
    expect(runtime.useExtensionsRuntime.getState().pages).toHaveLength(1)
    expect(runtime.useExtensionsRuntime.getState().slots).toHaveLength(2)
    extensions[0]!.revision = '2'
    await runtime.loadExtensions(qc)
    expect(activations).toBe(3)
    expect(cleanups).toBe(2)
    expect(runtime.useExtensionsRuntime.getState().pages.map((page) => page.id)).toEqual(['new-page'])
    expect(runtime.useExtensionsRuntime.getState().slots.map((slot) => slot.id)).toEqual(['new-slot'])
    expect([...links].map((link) => (link as { href: string }).href)).toContain(
      '/api/extensions/client-one/style.css?v=2',
    )
    expect(getCommand('runtime-new')).toBeDefined()
    extensions[0]!.needsApproval = true
    await runtime.loadExtensions(qc)
    expect(cleanups).toBe(3)
    expect(getCommand('runtime-new')).toBeUndefined()
    expect(runtime.useExtensionsRuntime.getState().pages).toHaveLength(0)
    expect(runtime.useExtensionsRuntime.getState().slots).toHaveLength(0)
    expect([...links].map((link) => (link as { href: string }).href)).not.toContain(
      '/api/extensions/client-one/style.css?v=2',
    )
    await runtime.loadExtensions(qc)
    expect(activations).toBe(3)
    // 列表中消失代表已卸载，仍在运行的另一个扩展也必须清理样式与变换。
    extensions.splice(2, 1)
    await runtime.loadExtensions(qc)
    expect(links.size).toBe(0)
    expect(runtime.useExtensionsRuntime.getState().transforms).toHaveLength(0)
    extensions.forEach((extension) => {
      extension.enabled = false
    })
    await runtime.loadExtensions(qc)
    expect(cleanups).toBe(3)
    expect(links.size).toBe(0)
    expect(runtime.useExtensionsRuntime.getState()).toMatchObject({
      slots: [],
      pages: [],
      transforms: [],
      listeners: [],
    })
  } finally {
    fetchMock.mockRestore()
    qc.clear()
    delete (globalThis as { document?: unknown }).document
    delete (globalThis as { location?: unknown }).location
  }
})
