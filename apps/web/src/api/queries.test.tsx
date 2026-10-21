import { expect, spyOn, test } from 'bun:test'
import type { ChatPage, GenerateEvent, MessageDTO } from '@nobot/shared'
import { InfiniteQueryObserver, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { runGeneration } from '../features/chat/generate'
import { api } from './client'
import { message } from './hooks.test-utils'
import { applyNewMessage, flattenPages, keys, resetChat, useChatPages } from './queries'

const chatId = 'first-round'
const makeMessage = (id: string, parentId: string | null, role: MessageDTO['role'] = 'assistant'): MessageDTO => ({
  ...message,
  chatId,
  id,
  parentId,
  role,
})
// 缓存操作只依赖分页和消息字段；其余元数据用于验证刷新期间仍保留同一份会话配置。
const makePage = (messages: MessageDTO[], hasMore = false) =>
  ({ messages, hasMore, playPresetId: 'vn-play', generating: false, chat: { id: chatId } }) as ChatPage
const makeClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } })

test('空消息缓存接受 null 父节点；根分支替换清空后续消息和旧分页游标', () => {
  const qc = makeClient()
  const reset = spyOn(qc, 'resetQueries')
  try {
    const root = makeMessage('user', null, 'user')
    qc.setQueryData(keys.chat(chatId), { pages: [makePage([])], pageParams: [undefined] })
    expect(applyNewMessage(qc, chatId, root)).toBe(true)
    expect(flattenPages(qc.getQueryData(keys.chat(chatId)))).toEqual([root])
    expect(reset).not.toHaveBeenCalled()

    qc.setQueryData(keys.chat(chatId), {
      pages: [makePage([makeMessage('tail', 'old')], true), makePage([makeMessage('old', null)])],
      pageParams: [undefined, 'old-cursor'],
    })
    expect(applyNewMessage(qc, chatId, root)).toBe(true)
    expect(qc.getQueryData(keys.chat(chatId))).toEqual({
      pages: [makePage([root])],
      pageParams: [undefined],
    })
    expect(applyNewMessage(qc, chatId, makeMessage('missing', 'unknown'))).toBe(false)
    expect(flattenPages(qc.getQueryData(keys.chat(chatId)))).toEqual([root])
    expect(applyNewMessage(qc, 'uncached', root)).toBe(false)
    expect(qc.getQueryData(keys.chat('uncached'))).toBeUndefined()
  } finally {
    reset.mockRestore()
    qc.clear()
  }
})

for (const scenario of ['单聊首轮', '群聊首轮两条回复', '空会话直接触发首条回复'] as const) {
  test(`${scenario}：完整 SSE 生成按父子顺序追加，不触发重置`, async () => {
    const qc = makeClient()
    const page = makePage([])
    qc.setQueryData(keys.chat(chatId), { pages: [page], pageParams: [undefined] })
    const user = scenario === '空会话直接触发首条回复' ? undefined : makeMessage('user', null, 'user')
    const first = makeMessage('first', user?.id ?? null)
    const second = makeMessage('second', first.id)
    const events: GenerateEvent[] = [
      { type: 'start', userMessage: user, assistantMessage: { ...first, content: '', status: 'streaming' } },
      { type: 'done', message: first },
      ...(scenario === '群聊首轮两条回复'
        ? ([
            { type: 'start', assistantMessage: { ...second, content: '', status: 'streaming' } },
            { type: 'done', message: second },
          ] satisfies GenerateEvent[])
        : []),
      { type: 'complete' },
    ]
    const reset = spyOn(qc, 'invalidateQueries')
    const getPage = spyOn(api, 'getChatPage').mockResolvedValue(page)
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(async () => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')), {
        preconnect: globalThis.fetch.preconnect,
      }),
    )
    const previousCancel = globalThis.cancelAnimationFrame
    globalThis.cancelAnimationFrame = () => {}
    try {
      await runGeneration(qc, chatId, user ? { mode: 'send', text: '你好', images: [] } : { mode: 'trigger' })
      expect(flattenPages(qc.getQueryData(keys.chat(chatId)))).toEqual([
        ...(user ? [user] : []),
        first,
        ...(scenario === '群聊首轮两条回复' ? [second] : []),
      ])
      expect(reset).not.toHaveBeenCalled()
    } finally {
      reset.mockRestore()
      getPage.mockRestore()
      fetchMock.mockRestore()
      globalThis.cancelAnimationFrame = previousCancel
      qc.clear()
    }
  })
}

test('重置期间保留 VN 所需数据和成功状态，只重新拉最新一页；新会话仍首次加载', async () => {
  const qc = makeClient()
  const page = makePage([makeMessage('old', null)], true)
  qc.setQueryData(keys.chat(chatId), {
    pages: [page, makePage([makeMessage('older', null)])],
    pageParams: [undefined, 'stale-cursor'],
  })
  const latest = makePage([makeMessage('new-branch', null)])
  let resolvePage!: (page: ChatPage) => void
  let requestStarted!: () => void
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve
  })
  const getPage = spyOn(api, 'getChatPage').mockImplementation(
    () =>
      new Promise<ChatPage>((resolve) => {
        resolvePage = resolve
        requestStarted()
      }),
  )
  const observer = new InfiniteQueryObserver(qc, {
    queryKey: keys.chat(chatId),
    queryFn: ({ pageParam }) => api.getChatPage(chatId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ChatPage) => (last.hasMore ? last.messages[0]?.id : undefined),
  })
  const states: boolean[] = []
  const unsubscribe = observer.subscribe((result) => states.push(result.isPending))
  let query!: ReturnType<typeof useChatPages>
  function Probe({ id }: { id: string }) {
    query = useChatPages(id)
    return null
  }
  const render = (id: string) =>
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <Probe id={id} />
      </QueryClientProvider>,
    )
  try {
    const resetting = resetChat(qc, chatId)
    // 等待取消旧请求、裁剪分页并开始新请求，响应由测试手动释放。
    await started
    render(chatId)
    expect(query.isFetching).toBe(true)
    expect(query.isPending).toBe(false)
    expect(query.data?.pages).toEqual([page])
    expect(query.data?.pageParams).toEqual([undefined])
    expect(query.data?.pages[0]?.playPresetId).toBe('vn-play')
    expect(getPage.mock.calls).toEqual([[chatId, undefined]])
    resolvePage(latest)
    await resetting
    render(chatId)
    expect(query.data?.pages).toEqual([latest])
    expect(states.length).toBeGreaterThan(0)
    expect(states.every((pending) => !pending)).toBe(true)
    render('different-chat')
    expect(query.isPending).toBe(true)
    expect(query.data).toBeUndefined()
  } finally {
    unsubscribe()
    getPage.mockRestore()
    qc.clear()
  }
})
