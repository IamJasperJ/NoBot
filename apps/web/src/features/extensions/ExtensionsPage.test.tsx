import { afterEach, expect, spyOn, test } from 'bun:test'
import type { ExtensionDTO } from '@ai-parter/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { keys } from '../../api/queries'
import * as layout from '../../components/layout'
import * as ui from '../../components/ui'
import { useExtensionsRuntime } from '../../extensions/runtime'
import { useUi } from '../../stores/ui'
import { ExtensionDetail, ExtensionsPage } from './ExtensionsPage'

const extension: ExtensionDTO = {
  id: 'fixture',
  name: '测试扩展',
  description: '扩展说明',
  author: '',
  version: '1',
  source: 'local',
  enabled: true,
  client: { script: true, style: false },
  permissions: null,
  detected: { server: false, client: false, routes: false, tools: false, hooks: false },
  permissionWarnings: [],
  needsApproval: false,
  git: null,
  revision: '1',
  hasRoutes: false,
  provides: { macros: [], tools: [], hooks: [] },
  settingsSchema: [],
  settings: {},
}
const initialUi = { ...useUi.getInitialState() }
const initialRuntime = { ...useExtensionsRuntime.getInitialState() }

afterEach(() => {
  useUi.setState(initialUi, true)
  Object.assign(useUi.getInitialState(), initialUi)
  Object.assign(useExtensionsRuntime.getInitialState(), initialRuntime)
})

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  client.setQueryData(keys.extensions, [extension])
  client.setQueryData(keys.tools, [])
  useExtensionsRuntime.getInitialState().pages = [
    { extensionId: extension.id, id: 'gallery', label: '测试图库', icon: '🖼', render: () => <p>图库正文</p> },
    { extensionId: 'other', id: 'hidden', label: '别人的页面', icon: '👋', render: () => '不可见' },
  ]
  const render = (node: ReactNode) => {
    Object.assign(useUi.getInitialState(), useUi.getState())
    return renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
  }
  const detail = () =>
    render(
      <ExtensionDetail
        extension={extension}
        onBack={() => {}}
        onDirtyChange={() => {}}
        update={async () => extension}
        busy={false}
        requestApproval={() => {}}
      />,
    )
  return { client, render, detail }
}

test('详情标签隔离扩展页面，openView 可以往返设置和页面，未知页面回退设置', () => {
  const { client, detail } = setup()
  try {
    useUi.getState().openView('extensions', extension.id)
    let html = detail()
    expect(html).toContain('role="tablist"')
    expect(html).toContain('🖼')
    expect(html).toContain('测试图库')
    expect(html).not.toContain('别人的页面')
    expect(html).not.toContain('图库正文')
    expect(html).toContain('overflow-x-auto')
    expect(html).toContain('sticky top-0')
    useUi.getState().openView('ext:fixture:gallery')
    expect(useUi.getState()).toMatchObject({
      view: 'extensions',
      focusId: 'fixture',
      extensionPageId: 'gallery',
      panelOpen: true,
      sidebarOpen: true,
    })
    html = detail()
    expect(html).toContain('图库正文')
    expect(html).toContain('aria-labelledby="extension-fixture-tab-1"')
    expect(html).toContain('hidden=""')
    useUi.getState().openView('extensions', extension.id)
    expect(detail()).not.toContain('图库正文')
    useUi.getState().openView('ext:fixture:missing')
    expect(detail()).toContain('aria-labelledby="extension-fixture-tab-0"')
    useExtensionsRuntime.getInitialState().pages = []
    expect(detail()).not.toContain('role="tablist"')
    expect(detail()).toContain('扩展说明')
  } finally {
    client.clear()
  }
})

test('列表快捷图标直接选中页面，详情标签点击可切回设置', () => {
  const { client, render } = setup()
  const clicks = new Map<string, () => void>()
  const original = ui.IconButton
  const icons = spyOn(ui, 'IconButton').mockImplementation((props) => {
    clicks.set(props.label, () => props.onClick?.({} as never))
    return original(props)
  })
  let detailNode: ReactNode
  const manager = spyOn(layout, 'ManagerLayout').mockImplementation((props) => {
    detailNode = props.detail
    return <>{props.list}</>
  })
  try {
    useUi.getState().openView('extensions')
    render(<ExtensionsPage />)
    clicks.get('打开测试扩展：测试图库')?.()
    expect(useUi.getState()).toMatchObject({ focusId: 'fixture', extensionPageId: 'gallery' })
    render(<ExtensionsPage />)
    const originalButton = ui.Button
    const buttons = spyOn(ui, 'Button').mockImplementation((props) => {
      if (props.role === 'tab' && props.id) clicks.set(props.id, () => props.onClick?.({} as never))
      return originalButton(props)
    })
    try {
      render(detailNode)
      clicks.get('extension-fixture-tab-0')?.()
      expect(useUi.getState().extensionPageId).toBeNull()
      expect(useUi.getState().focusId).toBe('fixture')
      render(detailNode)
      clicks.get('extension-fixture-tab-1')?.()
      expect(useUi.getState().extensionPageId).toBe('gallery')
    } finally {
      buttons.mockRestore()
    }
  } finally {
    manager.mockRestore()
    icons.mockRestore()
    client.clear()
  }
})
