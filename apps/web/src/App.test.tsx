/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { App } from './App'
import { keys } from './api/queries'
import { ManagerLayout } from './components/layout'
import { useExtensionsRuntime } from './extensions/runtime'
import { useUi } from './stores/ui'

const initial = { ...useUi.getInitialState() }

afterEach(() => {
  Object.assign(useUi.getInitialState(), initial)
})

function renderApp(state: Partial<typeof initial>) {
  // 静态渲染使用初始快照；浏览器中详情在挂载后才传送到覆盖层。
  Object.assign(useUi.getInitialState(), state)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  client.setQueryData(keys.characters, [])
  client.setQueryData(keys.connections, [])
  client.setQueryData(keys.personas, [])
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  )
}

describe('应用外壳', () => {
  test('注册的扩展页面不出现在左侧导航', () => {
    const runtime = useExtensionsRuntime.getInitialState()
    const pages = runtime.pages
    runtime.pages = [{ extensionId: 'fixture', id: 'gallery', label: '测试图库', icon: '🖼', render: () => '图库正文' }]
    try {
      const html = renderApp({ view: 'chat', chatId: null, panelOpen: false })
      expect(html).toContain('扩展')
      expect(html).not.toContain('测试图库')
      expect(html).not.toContain('图库正文')
    } finally {
      runtime.pages = pages
    }
  })

  test('打开角色面板时仍然渲染当前会话和输入框', () => {
    const html = renderApp({ view: 'characters', chatId: 'chat', panelOpen: true })
    expect(html).toContain('搜索角色')
    expect(html).toContain('aria-label="Prompt 预览"')
    expect(html).toContain('<textarea')
    expect(html).toContain('--panel-offset:var(--sidebar-width)')
    expect(html).toContain('id="overlay-root"')
  })

  test('关闭面板时卸载管理页，并取消导航高亮', () => {
    const html = renderApp({ view: 'characters', chatId: 'chat', panelOpen: false })
    expect(html).not.toContain('搜索角色')
    expect(html).not.toContain('aria-pressed="true"')
    expect(html).toContain('aria-label="展开侧栏"')
    expect(html).toContain('<textarea')
    expect(html).toContain('--panel-offset:0px')
  })

  test('未打开会话时，引导仍然保留在管理面板旁并使用对话列避让', () => {
    const html = renderApp({ view: 'connections', chatId: null, panelOpen: true })
    expect(html).toContain('还没有连接')
    expect(html).toContain('AI-Parter')
    expect(html).toContain('class="chat-column ')
  })

  test('简单详情在面板中替换列表，未选中时仅显示列表', () => {
    const render = (selected: boolean) =>
      renderToStaticMarkup(
        <ManagerLayout
          title="连接"
          detailIn="panel"
          showDetailOnMobile={selected}
          list={<p>连接列表</p>}
          detail={<p>连接编辑器</p>}
        />,
      )
    expect(render(true)).toContain('连接编辑器')
    expect(render(true)).not.toContain('连接列表')
    expect(render(false)).toContain('连接列表')
    expect(render(false)).not.toContain('连接编辑器')
  })
})
