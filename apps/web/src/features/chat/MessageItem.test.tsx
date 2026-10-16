import { expect, spyOn, test } from 'bun:test'
import type { MessageDTO } from '@ai-parter/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { keys } from '../../api/queries'
import { MessageItem, MessageMedia } from './MessageItem'

const image = { id: 'image', url: '/image.webp', mime: 'image/webp', width: 64, height: 64 }
function message(meta: MessageDTO['meta']): MessageDTO {
  return {
    id: 'message',
    chatId: 'chat',
    parentId: null,
    role: 'assistant',
    speakerId: null,
    content: '',
    status: 'done',
    swipeIndex: 1,
    swipeCount: 1,
    createdAt: 1,
    meta,
  } as MessageDTO
}
function frame(status: 'error' | 'pending' = 'error', error = '上游生成失败') {
  return { status, mode: 'free' as const, width: 832, height: 1216, prompt: 'cat'.repeat(40), negative: 'bad', error }
}

// 真实服务端渲染保留事件闭包，可验证操作请求和缓存更新而不引入 DOM 测试依赖。
function harness(initial: MessageDTO) {
  const qc = new QueryClient()
  qc.setQueryData(keys.chat('chat'), { pages: [{ messages: [initial] }], pageParams: [undefined] })
  let tree: ReactElement | null = null
  let current = initial
  function Probe() {
    tree = MessageMedia({ msg: current, chatId: 'chat' })
    return tree
  }
  function render(msg = current) {
    current = msg
    return renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    )
  }
  function button(label: string) {
    let found: { disabled?: boolean; onClick: () => void } | undefined
    function walk(node: ReactNode) {
      Children.forEach(node, (child) => {
        if (!isValidElement(child)) return
        const props = child.props as {
          children?: ReactNode
          label?: string
          'aria-label'?: string
          disabled?: boolean
          onClick?: () => void
        }
        if ((props.children === label || props.label === label || props['aria-label'] === label) && props.onClick)
          found = props as typeof found
        walk(props.children)
      })
    }
    walk(tree!)
    if (!found) throw new Error(`找不到按钮：${label}`)
    return found
  }
  const cached = () =>
    qc.getQueryData<{ pages: { messages: MessageDTO[] }[] }>(keys.chat('chat'))!.pages[0]!.messages[0]!
  return { qc, render, button, cached }
}

test('失败框采用占位尺寸、截断提示词、错误详情和三个操作；已取消使用灰色；工具消息也显示失败框', () => {
  const msg = message({ imageGen: frame() })
  const h = harness(msg)
  try {
    const html = h.render()
    for (const text of [
      '图片生成失败',
      '上游生成失败',
      '重新生成',
      '改提示词…',
      '放弃',
      'line-clamp-3',
      'ring-red-200',
      'width:min(320px, 100%)',
      'aspect-ratio:832 / 1216',
    ])
      expect(html).toContain(text)
    // 短错误不显示「详情」，长错误才可以展开
    expect(html).not.toContain('详情')
    expect(h.render(message({ imageGen: frame('error', '上游错误'.repeat(20)) }))).toContain('详情')
    expect(html).toContain(frame().prompt.slice(0, 80))
    expect(html).not.toContain(frame().prompt)
    const pending = h.render(message({ imageGen: frame('pending') }))
    expect(pending).toContain('width:min(320px, 100%)')
    expect(pending).toContain('aspect-ratio:832 / 1216')
    const canceled = h.render(message({ imageGen: frame('error', '已取消') }))
    expect(canceled).toContain('已取消')
    expect(canceled).toContain('bg-zinc-100')
    expect(canceled).not.toContain('ring-red-200')
    const tool = renderToStaticMarkup(
      <QueryClientProvider client={h.qc}>
        <MessageItem
          msg={{ ...msg, role: 'tool' }}
          chatId="chat"
          isLast
          busy={false}
          cast={{ speakers: {}, fallback: { name: '角色', avatarUrl: null }, user: { name: '用户', avatarUrl: null } }}
        />
      </QueryClientProvider>,
    )
    expect(tool).toContain('图片生成失败')
    expect(tool).toContain('改提示词…')
  } finally {
    h.qc.clear()
  }
})

test('失败格和排队格可以左右切换；放弃后选中最后一张成功图片', async () => {
  const msg = message({ images: [image], imageIndex: 1, imageGen: frame() })
  const h = harness(msg)
  const requests: { url: string; body: Record<string, unknown> }[] = []
  const mocked = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        const url = String(input)
        requests.push({ url, body })
        const saved = url.endsWith('/dismiss')
          ? { ...msg, meta: { ...msg.meta, imageIndex: 0, imageGen: { ...frame(), status: 'done', error: undefined } } }
          : { ...h.cached(), meta: { ...h.cached().meta, imageIndex: body.imageIndex } }
        return Response.json(url.endsWith('/dismiss') ? { message: saved } : saved)
      },
      { preconnect: fetch.preconnect },
    ),
  )
  try {
    expect(h.render()).toContain('2/2')
    expect(h.render()).not.toContain('<img')
    expect(h.button('下一张图片').disabled).toBe(true)
    h.button('上一张图片').onClick()
    await Bun.sleep(1)
    const previous = h.render(h.cached())
    expect(previous).toContain('1/2')
    expect(previous).toContain('/image.webp')
    expect(previous).not.toContain('role="alert"')
    h.button('下一张图片').onClick()
    await Bun.sleep(1)
    expect(h.render(h.cached())).toContain('图片生成失败')
    expect(requests.slice(0, 2).map((r) => r.body.imageIndex)).toEqual([0, 1])
    h.button('放弃').onClick()
    await Bun.sleep(1)
    expect(h.cached().meta.imageIndex).toBe(0)
    // 只剩一张图时不再显示「1/1」切换
    expect(h.render(h.cached())).not.toContain('1/1')
    expect(h.render(h.cached())).toContain('/image.webp')
    expect(h.render()).not.toContain('role="alert"')
    expect(h.render(message({ images: [image], imageIndex: 1, imageGen: frame('pending') }))).toContain('2/2')
    h.button('上一张图片').onClick()
    await Bun.sleep(1)
    expect(h.render(h.cached())).toContain('<img')
  } finally {
    mocked.mockRestore()
    h.qc.clear()
  }
})

test('原提示词重试不提交新词；无图放弃必须二次确认，取消确认不发请求', async () => {
  const h = harness(message({ imageGen: frame() }))
  const requests: { url: string; body: unknown }[] = []
  const mocked = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
        return Response.json({})
      },
      { preconnect: fetch.preconnect },
    ),
  )
  const originalConfirm = globalThis.confirm
  let confirmations = 0
  let confirmed = false
  globalThis.confirm = () => {
    confirmations++
    return confirmed
  }
  try {
    h.render()
    h.button('重新生成').onClick()
    await Bun.sleep(1)
    expect(requests).toEqual([{ url: '/api/ext/image-gen/retry', body: { messageId: 'message' } }])
    h.button('放弃').onClick()
    await Bun.sleep(1)
    expect(confirmations).toBe(1)
    expect(requests).toHaveLength(1)
    confirmed = true
    h.button('放弃').onClick()
    await Bun.sleep(1)
    expect(confirmations).toBe(2)
    expect(requests.at(-1)?.url).toBe('/api/ext/image-gen/dismiss')
  } finally {
    globalThis.confirm = originalConfirm
    mocked.mockRestore()
    h.qc.clear()
  }
})
