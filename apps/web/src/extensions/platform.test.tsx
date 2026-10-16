import { expect, spyOn, test } from 'bun:test'
import type { ExtensionDTO, MessageDTO } from '@ai-parter/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { api } from '../api/client'
import { keys } from '../api/queries'
import * as ui from '../components/ui'
import { MessageItem } from '../features/chat/MessageItem'
import { SettingsEditor } from '../features/extensions/SettingsEditor'
import { BUILTIN_CLIENTS } from './builtin'
import { emitClientEvent, hasListener, loadExtensions, useExtensionsRuntime } from './runtime'
import { Slot } from './Slot'

test('设置表单支持条件、密码、占位符、步长和分组', () => {
  const html = renderToStaticMarkup(
    <SettingsEditor
      extensionId="fixture"
      disabled={false}
      onChange={() => {}}
      values={{ backend: 'a', secret: 'key' }}
      fields={[
        { type: 'heading', key: 'group', label: '接口配置', hint: '分组说明' },
        { type: 'string', key: 'secret', label: '密钥', secret: true, placeholder: '填写密钥' },
        { type: 'textarea', key: 'prompt', label: '提示词', rows: 7, placeholder: '填写描述' },
        { type: 'number', key: 'scale', label: '比例', step: 0.5 },
        { type: 'string', key: 'hidden', label: '隐藏字段', visibleWhen: { key: 'backend', equals: 'b' } },
        { type: 'string', key: 'visible', label: '可见字段', visibleWhen: { key: 'backend', equals: ['a', 'b'] } },
      ]}
    />,
  )
  expect(html).toContain('接口配置')
  expect(html).toContain('分组说明')
  expect(html).toContain('type="password"')
  expect(html).toContain('填写密钥')
  expect(html).toContain('填写描述')
  expect(html).toContain('rows="7"')
  expect(html).toContain('step="0.5"')
  expect(html).not.toContain('隐藏字段')
  expect(html).toContain('可见字段')
})

test('内置前端共用激活与清理，并将设置插槽限制为扩展自己', async () => {
  const qc = new QueryClient()
  let cleaned = 0
  let activations = 0
  const extension: ExtensionDTO = {
    id: 'fixture-client',
    name: '测试',
    version: '1',
    description: '',
    source: 'builtin',
    enabled: true,
    provides: { macros: [], tools: [], hooks: [] },
    settingsSchema: [],
    settings: {},
    author: '',
    client: { script: false, style: false },
    hasRoutes: false,
  }
  const mocked = spyOn(api, 'listExtensions').mockResolvedValue([extension])
  BUILTIN_CLIENTS[extension.id] = (api) => {
    activations++
    api.registerSlot('extensions.settings.footer', {
      id: 'settings',
      render: ({ settings }) => <span>自己的设置：{String(settings.value)}</span>,
    })
    return () => {
      cleaned++
    }
  }
  try {
    await loadExtensions(qc)
    await loadExtensions(qc)
    expect(activations).toBe(1)
    // 服务端渲染读取 Zustand 初始快照，复制已激活贡献以验证插槽过滤。
    useExtensionsRuntime.getInitialState().slots = useExtensionsRuntime.getState().slots
    const own = renderToStaticMarkup(
      <Slot name="extensions.settings.footer" props={{ extensionId: extension.id, settings: { value: '草稿' } }} />,
    )
    expect(own).toContain('自己的设置：草稿')
    expect(
      renderToStaticMarkup(<Slot name="extensions.settings.footer" props={{ extensionId: 'other', settings: {} }} />),
    ).toBe('')
    mocked.mockResolvedValue([{ ...extension, enabled: false }])
    await loadExtensions(qc)
    expect(cleaned).toBe(1)
    expect(useExtensionsRuntime.getState().slots).toHaveLength(0)
  } finally {
    useExtensionsRuntime.getInitialState().slots = []
    mocked.mockRestore()
    delete BUILTIN_CLIENTS[extension.id]
    qc.clear()
  }
})

test('助手与工具显示图片、异步占位和失败信息', () => {
  const qc = new QueryClient()
  const msg: MessageDTO = {
    id: 'message',
    chatId: 'chat',
    parentId: null,
    role: 'assistant',
    content: '',
    status: 'done',
    speakerId: null,
    meta: {},
    createdAt: 0,
    swipeIndex: 1,
    swipeCount: 1,
  }
  const render = (message: MessageDTO) =>
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MessageItem
          msg={message}
          chatId="chat"
          isLast={false}
          busy={false}
          cast={{ speakers: {}, fallback: { name: '画师', avatarUrl: null }, user: { name: '旅人', avatarUrl: null } }}
        />
      </QueryClientProvider>,
    )
  for (const role of ['assistant', 'tool', 'user', 'system'] as const) {
    const html = render({
      ...msg,
      role,
      meta: { images: [{ id: 'image', url: '/fixture-image.webp', width: 512, height: 512 }] },
    })
    expect(html).toContain('/fixture-image.webp')
    expect(html).toContain('target="_blank"')
  }
  const pending = render({
    ...msg,
    meta: { imageGen: { mode: 'last', status: 'pending', width: 768, height: 512, prompt: '月光森林' } },
  })
  expect(pending).toContain('生成中…')
  expect(pending).toContain('取消')
  const stages = {
    prompt: '正在写提示词…',
    confirm: '等待确认…',
    queued: '排队中（第 2 位）',
    generating: '生成中…',
    saving: '保存中…',
  } as const
  for (const [stage, label] of Object.entries(stages)) {
    const staged = render({
      ...msg,
      meta: {
        images: [{ id: 'existing', url: '/existing.webp', width: 512, height: 512 }],
        imageGen: { mode: 'last', status: 'pending', stage: stage as keyof typeof stages, queuePosition: 2 },
      },
    })
    expect(staged).toContain(label)
    expect(staged).not.toContain('/existing.webp')
    expect(staged).toContain('2/2')
    expect(staged).toContain('上一张图片')
  }
  expect(pending).toContain('月光森林')
  expect(pending).toContain('aspect-ratio:768 / 512')
  expect(pending).not.toContain('<p></p>')
  const failure = render({
    ...msg,
    role: 'tool',
    meta: { imageGen: { mode: 'last', status: 'error', error: '服务不可用' } },
  })
  expect(failure).toContain('图片生成失败')
  expect(failure).toContain('服务不可用')
  qc.clear()
})

test('生成图片仅展示所选一张、计数正确，上传图片仍全部显示，箭头保存接口并乐观更新', async () => {
  const qc = new QueryClient()
  const msg: MessageDTO = {
    id: 'swipe-message',
    chatId: 'chat',
    parentId: null,
    role: 'assistant',
    content: '',
    status: 'done',
    speakerId: null,
    createdAt: 0,
    swipeIndex: 1,
    swipeCount: 1,
    meta: {
      imageGen: { mode: 'last', status: 'done' },
      images: [0, 1, 2].map((i) => ({ id: `image-${i}`, url: `/image-${i}.webp`, width: 512, height: 512 })),
    },
  }
  const clicks = new Map<string, () => void>()
  const originalButton = ui.Button
  const newImageButton = spyOn(ui, 'Button').mockImplementation((props: ComponentProps<typeof ui.Button>) => {
    if (props['aria-label'] === '生成新图' && props.onClick && !props.disabled)
      clicks.set('生成新图', () => props.onClick?.({} as never))
    return originalButton(props)
  })
  const original = ui.IconButton
  const buttons = spyOn(ui, 'IconButton').mockImplementation((props: ComponentProps<typeof ui.IconButton>) => {
    if (props.onClick && !props.disabled) clicks.set(props.label, () => props.onClick?.({} as never))
    return original(props)
  })
  let resolveRequest: (message: MessageDTO) => void = () => {}
  const saved = spyOn(api, 'updateMessageImageIndex').mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveRequest = resolve
      }),
  )
  const render = (message: MessageDTO) =>
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MessageItem
          msg={message}
          chatId="chat"
          isLast={false}
          busy={false}
          cast={{ speakers: {}, fallback: { name: '画师', avatarUrl: null }, user: { name: '旅人', avatarUrl: null } }}
        />
      </QueryClientProvider>,
    )
  try {
    qc.setQueryData(keys.chat('chat'), { pages: [{ messages: [msg] }] })
    const html = render(msg)
    expect(html).toContain('3/3')
    expect(html.match(/<img /g)).toHaveLength(1)
    expect(html).toContain('src="/image-2.webp"')
    expect(clicks.has('下一张图片')).toBe(false)
    clicks.get('上一张图片')?.()
    expect(saved).toHaveBeenCalledWith(msg.id, 1)
    expect(
      qc.getQueryData<{ pages: { messages: MessageDTO[] }[] }>(keys.chat('chat'))?.pages[0]?.messages[0]?.meta
        .imageIndex,
    ).toBe(1)
    const selected = { ...msg, meta: { ...msg.meta, imageIndex: 1 } }
    resolveRequest(selected)
    await Promise.resolve()
    expect(render(selected)).toContain('2/3')
    expect(render({ ...msg, meta: { images: msg.meta.images ?? [] } }).match(/<img /g)).toHaveLength(3)
    let nextMessage: MessageDTO | undefined
    useExtensionsRuntime.setState({
      listeners: [
        {
          extensionId: 'fixture',
          type: 'image:swipe-next',
          handler: (event) => {
            if (event.type === 'image:swipe-next') nextMessage = event.message
          },
        },
      ],
    })
    render(msg)
    expect(render(msg)).toContain('＋ 生成新图')
    expect(clicks.has('生成新图')).toBe(true)
    clicks.get('生成新图')?.()
    expect(nextMessage).toEqual(msg)
    expect(saved).toHaveBeenCalledTimes(1)
  } finally {
    useExtensionsRuntime.setState({ listeners: [] })
    newImageButton.mockRestore()
    buttons.mockRestore()
    saved.mockRestore()
    qc.clear()
  }
})

test('图片 swipe 事件监听可以查询，并向扩展传递完整消息', () => {
  let received = ''
  useExtensionsRuntime.setState({
    listeners: [
      {
        extensionId: 'fixture',
        type: 'image:swipe-next',
        handler: (event) => {
          received = 'chatId' in event ? (event.chatId ?? '') : ''
        },
      },
    ],
  })
  expect(hasListener('image:swipe-next')).toBe(true)
  const message = { id: 'image-message' } as MessageDTO
  emitClientEvent({ type: 'image:swipe-next', chatId: 'fixture-chat', message })
  expect(received).toBe('fixture-chat')
  useExtensionsRuntime.setState({ listeners: [] })
  expect(hasListener('image:swipe-next')).toBe(false)
})

test('候选设置保持手动输入和自定义选择值', () => {
  const html = renderToStaticMarkup(
    <SettingsEditor
      extensionId="fixture"
      disabled={false}
      onChange={() => {}}
      values={{ model: 'custom', style: 'custom-style' }}
      fields={[
        { type: 'string', key: 'model', label: '模型', optionsSource: 'models' },
        {
          type: 'select',
          key: 'style',
          label: '风格',
          options: [{ value: 'a', label: '内置风格' }],
          optionsSource: 'styles',
        },
      ]}
    />,
  )
  expect(html).toContain('<datalist')
  expect(html).toContain('value="custom"')
  expect(html).toContain('custom-style（自定义）')
  expect(html).toContain('内置风格')
  expect(html).toContain('拉取模型')
  expect(html).toContain('拉取风格')
})
