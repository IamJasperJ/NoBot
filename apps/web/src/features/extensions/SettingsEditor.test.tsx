import { expect, spyOn, test } from 'bun:test'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ui from '../../components/ui'
import { toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { SettingsEditor } from './SettingsEditor'

test('候选自动拉取使用表单草稿，自动失败静默，手动刷新失败提示且使用最新草稿', async () => {
  const previousChat = useUi.getState().chatId
  useUi.setState({ chatId: 'current-chat' })
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location')
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'http://localhost' } })
  const effects: React.EffectCallback[] = []
  const states: unknown[] = []
  const useState = React.useState
  const state = spyOn(React, 'useState').mockImplementation(((initial: unknown) => {
    const [value] = useState(initial)
    return [
      value,
      (next: unknown) => {
        states.push(next)
      },
    ]
  }) as typeof React.useState)
  const effect = spyOn(React, 'useEffect').mockImplementation((callback) => {
    effects.push(callback)
  })
  // 「拉取」现在是和输入框同高的图标按钮
  const original = ui.IconButton
  let refresh: (() => void) | undefined
  const button = spyOn(ui, 'IconButton').mockImplementation((props) => {
    if (props.label === '拉取模型') refresh = () => props.onClick?.({} as never)
    return original(props)
  })
  const errors = spyOn(toast, 'error').mockImplementation(() => {})
  const urls: URL[] = []
  const bodies: { settings?: unknown; chatId?: string }[] = []
  let response = Response.json({ error: { message: '接口未就绪' } }, { status: 503 })
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    urls.push(new URL(String(input)))
    // 草稿设置放在 POST 请求体里（网址放不下整份工作流）
    bodies.push(JSON.parse(String(init?.body ?? '{}')))
    return response.clone()
  }) as typeof globalThis.fetch)
  const render = (settings: Record<string, unknown>) =>
    renderToStaticMarkup(
      <SettingsEditor
        extensionId="fixture"
        disabled={false}
        values={{ model: 'custom' }}
        settings={settings}
        onChange={() => {}}
        fields={[{ type: 'string', key: 'model', label: '模型', optionsSource: 'models' }]}
      />,
    )
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  try {
    render({ backend: 'first', token: 'unsaved' })
    const cleanup = effects[0]?.()
    await settle()
    expect(urls[0]?.pathname).toBe('/api/ext/fixture/models')
    expect(bodies[0]?.chatId).toBe('current-chat')
    expect(bodies[0]?.settings).toEqual({ backend: 'first', token: 'unsaved' })
    expect(states).toContain('接口未就绪')
    expect(errors).not.toHaveBeenCalled()
    render({ backend: 'second' })
    refresh?.()
    await settle()
    expect(bodies[1]?.settings).toEqual({ backend: 'second' })
    expect(errors).toHaveBeenCalledWith('接口未就绪')
    response = Response.json({ options: [{ value: 'remote', label: '远程模型' }] })
    refresh?.()
    await settle()
    expect(states).toContainEqual([{ value: 'remote', label: '远程模型' }])
    if (typeof cleanup === 'function') cleanup()
  } finally {
    useUi.setState({ chatId: previousChat })
    fetch.mockRestore()
    errors.mockRestore()
    button.mockRestore()
    effect.mockRestore()
    state.mockRestore()
    if (location) Object.defineProperty(globalThis, 'location', location)
    else Reflect.deleteProperty(globalThis, 'location')
  }
})

test('自定义、跟随连接与内置工作流的空值选项保留说明文字', () => {
  const html = renderToStaticMarkup(
    <SettingsEditor
      extensionId="image-gen"
      disabled={false}
      values={{ connection: '', promptConnection: '', workflow: '' }}
      onChange={() => {}}
      fields={[
        {
          key: 'connection',
          label: '图片连接',
          type: 'select',
          options: [{ value: '', label: '自定义（下面填写地址和密钥）' }],
          optionsSource: 'connections',
        },
        {
          key: 'promptConnection',
          label: '提示词连接',
          type: 'select',
          options: [{ value: '', label: '跟随当前会话的连接' }],
          optionsSource: 'connections',
        },
        { key: 'workflow', label: '工作流', type: 'select', options: [{ value: '', label: '内置默认' }] },
      ]}
    />,
  )
  expect(html).toContain('自定义（下面填写地址和密钥）')
  expect(html).toContain('跟随当前会话的连接')
  expect(html).toContain('内置默认')
  expect(html).not.toContain('请选择')
})

// 用组件树驱动事件与重新渲染，避免为表单交互额外引入 DOM 测试依赖。
function editorHarness(initial: React.ComponentProps<typeof SettingsEditor>) {
  type Element = { type: unknown; key?: string | null; props: Record<string, unknown> }
  type Native = { type: string; props: Record<string, unknown>; text: string; path: string }
  const state = new Map<string, unknown>()
  const refs = new Map<string, { current: unknown }>()
  let owner = ''
  let slot = 0
  let nodes: Native[] = []
  let effects: React.EffectCallback[] = []
  let props = initial
  let focused = 0
  const mocks = [
    spyOn(React, 'useState').mockImplementation(((initialValue: unknown) => {
      const key = `${owner}:${slot++}`
      if (!state.has(key)) state.set(key, typeof initialValue === 'function' ? initialValue() : initialValue)
      return [
        state.get(key),
        (next: unknown) => {
          state.set(key, typeof next === 'function' ? next(state.get(key)) : next)
        },
      ]
    }) as typeof React.useState),
    spyOn(React, 'useRef').mockImplementation(((initialValue: unknown) => {
      const key = `${owner}:${slot++}`
      if (!refs.has(key)) refs.set(key, { current: initialValue })
      return refs.get(key)
    }) as typeof React.useRef),
    spyOn(React, 'useId').mockImplementation(() => `${owner}:${slot++}`),
    spyOn(React, 'useEffect').mockImplementation((callback) => {
      effects.push(callback)
    }),
  ]
  function walk(node: React.ReactNode, path: string): string {
    if (node == null || typeof node === 'boolean') return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node))
      return node
        .map((child, index) => walk(child, `${path}/${React.isValidElement(child) ? (child.key ?? index) : index}`))
        .join('')
    const element = node as Element
    if (typeof element.type === 'function') {
      owner = `${path}/${element.type.name}:${element.key ?? ''}`
      slot = 0
      return walk((element.type as (props: unknown) => React.ReactNode)(element.props), owner)
    }
    const text = walk(element.props.children as React.ReactNode, `${path}/children`)
    if (typeof element.type === 'string') {
      nodes.push({ type: element.type, props: element.props, text, path })
      const ref = element.props.ref as { current: unknown } | undefined
      if (ref)
        ref.current = {
          getBoundingClientRect: () => ({ left: 20, bottom: 80 }),
          contains: () => false,
          focus: () => {
            focused++
          },
          querySelector: () => ({
            focus: () => {
              focused++
            },
          }),
        }
    }
    return text
  }
  function render() {
    nodes = []
    effects = []
    walk(<SettingsEditor {...props} />, 'root')
  }
  render()
  return {
    get nodes() {
      return nodes
    },
    get focused() {
      return focused
    },
    render,
    update(next: Partial<typeof props>) {
      props = { ...props, ...next }
      render()
    },
    flushEffects() {
      return effects.map((callback) => callback())
    },
    flushEffect(index: number) {
      return effects[index]?.()
    },
    click(text: string) {
      const button = nodes.find(
        (node) => node.type === 'button' && (node.props['aria-label'] === text || node.text === text),
      )
      if (!button) throw new Error(`找不到按钮：${text}`)
      ;(button.props.onClick as () => void)()
      render()
    },
    restore() {
      for (const mock of mocks) mock.mockRestore()
    },
  }
}

test('分组默认收起、标题展开、持久化、全部切换及整组隐藏', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const saved = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    },
  })
  const harness = editorHarness({
    extensionId: 'groups',
    disabled: false,
    values: { show: false },
    onChange: () => {},
    fields: [
      { type: 'heading', key: 'advanced', label: '高级', defaultCollapsed: true, hint: '高级说明' },
      { type: 'string', key: 'name', label: '名称' },
      { type: 'heading', key: 'hidden', label: '隐藏分组' },
      { type: 'string', key: 'secret', label: '条件字段', visibleWhen: { key: 'show', equals: true } },
      { type: 'heading', key: 'other', label: '其他' },
      { type: 'boolean', key: 'enabled', label: '启用' },
    ],
  })
  try {
    expect(harness.nodes.some((node) => node.type === 'input')).toBe(false)
    expect(harness.nodes.some((node) => node.text === '1 项')).toBe(true)
    expect(harness.nodes.some((node) => node.text === '隐藏分组')).toBe(false)
    harness.click('高级高级说明1 项')
    expect(harness.nodes.some((node) => node.type === 'input')).toBe(true)
    expect(JSON.parse(saved.get('ext-settings-collapsed:groups') ?? '{}')).toEqual({ advanced: false })
    harness.click('切换全部分组')
    expect(harness.nodes.some((node) => node.type === 'input')).toBe(false)
    harness.click('切换全部分组')
    expect(harness.nodes.some((node) => node.type === 'input')).toBe(true)
    harness.update({ extensionId: 'another' })
    expect(harness.nodes.some((node) => node.type === 'input')).toBe(false)
    harness.update({ extensionId: 'groups' })
    expect(harness.nodes.some((node) => node.type === 'input')).toBe(true)
  } finally {
    harness.restore()
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})

test('列表默认标题、select 中文名、全部展开收起、新增聚焦及嵌套列表', () => {
  let draft: Record<string, unknown> = { items: [{ mode: 'portrait', name: '第一项' }, { name: '' }] }
  const changes: Record<string, unknown>[] = []
  const harness = editorHarness({
    extensionId: 'list',
    disabled: false,
    values: draft,
    onChange: (next) => {
      draft = next
      changes.push(next)
    },
    fields: [
      {
        type: 'list',
        key: 'items',
        label: '类型',
        titleKey: 'mode',
        itemFields: [
          { type: 'select', key: 'mode', label: '生成类型', options: [{ value: 'portrait', label: '肖像' }] },
          { type: 'string', key: 'name', label: '名称' },
          {
            type: 'list',
            key: 'children',
            label: '子项',
            itemFields: [{ type: 'string', key: 'name', label: '子名称' }],
          },
        ],
      },
    ],
  })
  try {
    expect(harness.nodes.some((node) => node.type === 'select')).toBe(false)
    expect(harness.nodes.some((node) => node.text === '肖像')).toBe(true)
    expect(harness.nodes.some((node) => node.text === '（未命名）')).toBe(true)
    harness.click('肖像')
    expect(harness.nodes.filter((node) => node.type === 'select')).toHaveLength(1)
    harness.click('切换全部类型')
    expect(harness.nodes.filter((node) => node.type === 'select')).toHaveLength(2)
    harness.click('切换全部类型')
    expect(harness.nodes.filter((node) => node.type === 'select')).toHaveLength(0)
    harness.click('添加一项')
    harness.update({ values: draft })
    harness.flushEffects()
    expect(harness.focused).toBe(1)
    expect(harness.nodes.filter((node) => node.type === 'select')).toHaveLength(1)
    expect(changes).toHaveLength(1)
    expect(draft.items).toEqual([
      { mode: 'portrait', name: '第一项' },
      { name: '' },
      { mode: '', name: '', children: [] },
    ])
    // 新项的子列表仍能添加并自动展开。
    harness.click('添加一项')
    harness.update({ values: draft })
    expect(harness.nodes.some((node) => node.text === '子名称')).toBe(true)
    harness.update({ extensionId: 'other-list' })
    expect(harness.nodes.some((node) => node.type === 'select' || node.type === 'input')).toBe(false)
  } finally {
    harness.restore()
  }
})

test('附着字段同行排序、高亮、草稿编辑、外部点击和 Esc 关闭及显隐联动', () => {
  const previous = ['document', 'window', 'Node'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  )
  const handlers = new Map<string, (event: unknown) => void>()
  class FakeNode {}
  Object.defineProperty(globalThis, 'Node', { configurable: true, value: FakeNode })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      body: {},
      addEventListener: (type: string, listener: (event: unknown) => void) => handlers.set(type, listener),
      removeEventListener: (type: string) => handlers.delete(type),
    },
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      innerWidth: 320,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  })
  const portal = spyOn(ReactDOM, 'createPortal').mockImplementation((children) => children as React.ReactPortal)
  let draft: Record<string, unknown> = { show: true, headers: '{}', enabled: false }
  const harness = editorHarness({
    extensionId: 'attached',
    disabled: false,
    values: draft,
    onChange: (next) => {
      draft = next
    },
    fields: [
      {
        type: 'string',
        key: 'url',
        label: '地址',
        optionsSource: 'models',
        visibleWhen: { key: 'show', equals: true },
      },
      { type: 'textarea', key: 'headers', label: '请求头', hint: 'JSON 说明', attachTo: 'url', attachLabel: '头' },
      {
        type: 'boolean',
        key: 'enabled',
        label: '附着开关',
        attachTo: 'url',
        attachLabel: '开',
        visibleWhen: { key: 'show', equals: true },
      },
    ],
  })
  try {
    expect(harness.nodes.some((node) => node.type === 'textarea')).toBe(false)
    const header = harness.nodes.find((node) => node.props['aria-label'] === '请求头')
    expect(header?.props.title).toBe('请求头')
    expect(header?.props.className).toContain('bg-violet-50')
    expect(harness.nodes.find((node) => node.props['aria-label'] === '附着开关')?.props.className).toContain(
      'border-zinc-200 bg-white',
    )
    const row = harness.nodes.find((node) => node.type === 'div' && node.props.className === 'flex items-end gap-2')
    // 标题在输入行上方；行内依次是输入框、附着按钮（头、开），最后是只有图标的「拉取」按钮
    expect(row?.text).toBe('头开')
    harness.click('请求头')
    expect(harness.nodes.find((node) => node.props.role === 'dialog')?.props['aria-label']).toBe('请求头')
    expect(harness.nodes.some((node) => node.text === 'JSON 说明')).toBe(true)
    const textarea = harness.nodes.find((node) => node.type === 'textarea')
    if (!textarea) throw new Error('浮层没有渲染编辑控件')
    ;(textarea.props.onChange as (event: unknown) => void)({ target: { value: '{"Authorization":"token"}' } })
    expect(draft.headers).toBe('{"Authorization":"token"}')
    harness.update({ values: draft })
    // effect 顺序：远程候选拉取、可输入下拉框、请求头浮层。
    const cleanup = harness.flushEffect(2)
    handlers.get('keydown')?.({ key: 'Escape', stopPropagation: () => {} })
    harness.render()
    expect(harness.nodes.some((node) => node.props.role === 'dialog')).toBe(false)
    if (typeof cleanup === 'function') cleanup()
    harness.click('请求头')
    const outsideCleanup = harness.flushEffect(2)
    handlers.get('pointerdown')?.({ target: new FakeNode() })
    harness.render()
    expect(harness.nodes.some((node) => node.type === 'textarea')).toBe(false)
    if (typeof outsideCleanup === 'function') outsideCleanup()
    harness.update({ values: { ...draft, show: false } })
    expect(harness.nodes.some((node) => node.props['aria-label'] === '请求头')).toBe(false)
    expect(harness.nodes.some((node) => node.props['aria-label'] === '附着开关')).toBe(false)
  } finally {
    harness.restore()
    portal.mockRestore()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('列表回退到首个字符串标题，移动和删除时展开状态跟随项目', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'confirm')
  Object.defineProperty(globalThis, 'confirm', { configurable: true, value: () => true })
  let draft: Record<string, unknown> = { items: [{ name: '甲' }, { name: '乙' }] }
  const harness = editorHarness({
    extensionId: 'ordering',
    disabled: false,
    values: draft,
    onChange: (next) => {
      draft = next
    },
    fields: [
      { type: 'list', key: 'items', label: '规则', itemFields: [{ type: 'string', key: 'name', label: '名称' }] },
    ],
  })
  try {
    harness.click('甲')
    harness.click('下移')
    harness.update({ values: draft })
    expect(draft.items).toEqual([{ name: '乙' }, { name: '甲' }])
    expect(harness.nodes.filter((node) => node.type === 'input').map((node) => node.props.value)).toEqual(['甲'])
    harness.click('删除规则第 1 项')
    harness.update({ values: draft })
    expect(draft.items).toEqual([{ name: '甲' }])
    expect(harness.nodes.filter((node) => node.type === 'input').map((node) => node.props.value)).toEqual(['甲'])
  } finally {
    harness.restore()
    if (descriptor) Object.defineProperty(globalThis, 'confirm', descriptor)
    else Reflect.deleteProperty(globalThis, 'confirm')
  }
})

test('附着字段自己的条件独立生效，非空字符串、数组和 true 高亮，空值使用次要样式', () => {
  for (const [value, filled] of [
    ['', false],
    [[], false],
    [false, false],
    ['内容', true],
    [['项目'], true],
    [true, true],
  ] as const) {
    const render = (show: boolean) =>
      renderToStaticMarkup(
        <SettingsEditor
          extensionId="highlight"
          disabled={false}
          values={{ extra: value, show }}
          onChange={() => {}}
          fields={[
            { type: 'string', key: 'url', label: '地址' },
            {
              type: 'string',
              key: 'extra',
              label: '附着内容',
              attachTo: 'url',
              attachLabel: '附',
              visibleWhen: { key: 'show', equals: true },
            },
          ]}
        />,
      )
    expect(render(true).includes('border-violet-300 bg-violet-50')).toBe(filled)
    expect(render(false)).not.toContain('aria-label="附着内容"')
  }
})
