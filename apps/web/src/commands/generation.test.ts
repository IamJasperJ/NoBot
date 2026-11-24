import { expect, jest, spyOn, test } from 'bun:test'
import type { ChatPage, GenerateEvent, MessageDTO } from '@nobot/shared'
import { QueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { flattenPages, keys } from '../api/queries'
import { runGeneration, syncChatFromServer, waitForGenerationIdle } from '../features/chat/generate'
import { type CommandEvent, onCommandEvent } from './events'

const message = (id: string, role: MessageDTO['role'], parentId: string | null): MessageDTO => ({
  id,
  role,
  parentId,
  chatId: 'automation-chat',
  content: 'text',
  status: 'done',
  meta: {},
  speakerId: null,
  createdAt: 0,
  swipeIndex: 1,
  swipeCount: 1,
})

test('流结束后的外部更新合并处理，收尾期间不会丢失通知', async () => {
  jest.useFakeTimers()
  const qc = new QueryClient()
  const chatId = 'trailing-sync'
  qc.setQueryData(keys.chat(chatId), { pages: [{}], pageParams: [undefined] })
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => new Response('data: {"type":"complete"}\n\n'), {
      preconnect: globalThis.fetch.preconnect,
    }),
  )
  const getPage = spyOn(api, 'getChatPage').mockResolvedValue({} as ChatPage)
  const previousCancel = globalThis.cancelAnimationFrame
  globalThis.cancelAnimationFrame = () => {}
  try {
    await runGeneration(qc, chatId, { mode: 'send', text: 'text', images: [] })
    syncChatFromServer(qc, chatId)
    syncChatFromServer(qc, chatId)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(1500)
    await waitForGenerationIdle(chatId)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(`/${chatId}/stream`)
    jest.advanceTimersByTime(1500)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  } finally {
    getPage.mockRestore()
    fetchMock.mockRestore()
    globalThis.cancelAnimationFrame = previousCancel
    qc.clear()
    jest.useRealTimers()
  }
})

test('生成正在读流时收到外部更新，流结束后合并同步一次', async () => {
  jest.useFakeTimers()
  const qc = new QueryClient()
  const chatId = 'sync-during-generation'
  const page = { messages: [], chat: { activeLeafId: null } } as unknown as ChatPage
  qc.setQueryData(keys.chat(chatId), { pages: [page], pageParams: [undefined] })
  const complete = 'data: {"type":"complete"}\n\n'
  let finish!: () => void
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      finish = () => {
        controller.enqueue(new TextEncoder().encode(complete))
        controller.close()
      }
    },
  })
  const fetchMock = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(body))
    .mockResolvedValueOnce(new Response(complete))
  const getPage = spyOn(api, 'getChatPage').mockResolvedValue(page)
  const previousCancel = globalThis.cancelAnimationFrame
  globalThis.cancelAnimationFrame = () => {}
  try {
    const generation = runGeneration(qc, chatId, { mode: 'trigger' })
    syncChatFromServer(qc, chatId)
    syncChatFromServer(qc, chatId)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    finish()
    await generation
    jest.advanceTimersByTime(1500)
    await waitForGenerationIdle(chatId)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(`/${chatId}/stream`)
    jest.advanceTimersByTime(1500)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  } finally {
    getPage.mockRestore()
    fetchMock.mockRestore()
    globalThis.cancelAnimationFrame = previousCancel
    qc.clear()
    jest.useRealTimers()
  }
})

test('SSE 完成后触发自动执行，携带深度与世界书元数据；等待生成释放后再执行', async () => {
  const qc = new QueryClient()
  const chatId = 'automation-chat'
  const root = message('root', 'system', null)
  const user = message('user', 'user', root.id)
  const assistant = message('assistant', 'assistant', user.id)
  const done = { ...assistant, meta: { lore: { automationIds: ['scene'] } } } as MessageDTO
  const page = { messages: [root], chat: {}, vars: {}, stage: null } as unknown as ChatPage
  qc.setQueryData(keys.chat(chatId), { pages: [page], pageParams: [undefined] })
  const getPage = spyOn(api, 'getChatPage').mockImplementation(async () => page)
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
  })
  const send = (event: GenerateEvent) =>
    controller?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => new Response(stream), { preconnect: globalThis.fetch.preconnect }),
  )
  const previousCancel = globalThis.cancelAnimationFrame
  globalThis.cancelAnimationFrame = () => {}
  const events: CommandEvent[] = []
  const off = onCommandEvent((event) => events.push(event))
  try {
    const generation = runGeneration(qc, chatId, { mode: 'send', text: 'text', images: [] }, 1)
    let idle = false
    const waiting = waitForGenerationIdle(chatId).then(() => {
      idle = true
    })
    await Promise.resolve()
    expect(idle).toBe(false)
    send({ type: 'start', userMessage: user, assistantMessage: assistant })
    send({ type: 'done', message: done })
    send({ type: 'complete' })
    controller?.close()
    await generation
    await waiting
    expect(idle).toBe(true)
    expect(events).toEqual([
      { type: 'onUser', chatId, depth: 1 },
      { type: 'onAi', chatId, depth: 1, messages: [done] },
    ])
  } finally {
    off()
    getPage.mockRestore()
    fetchMock.mockRestore()
    globalThis.cancelAnimationFrame = previousCancel
    qc.clear()
  }
})

test('已接受的发送断流后沿用同一轮次重连，重放用户消息只触发一次自动执行', async () => {
  const qc = new QueryClient()
  const chatId = 'interrupted-generation'
  const root = { ...message('root', 'system', null), chatId }
  const user = { ...message('user', 'user', root.id), chatId }
  const assistant = { ...message('assistant', 'assistant', user.id), chatId, content: '完整回复' }
  const streaming = { ...assistant, content: '', status: 'streaming' } as const
  const page = { messages: [root], generating: false, chat: { activeLeafId: root.id } } as ChatPage
  qc.setQueryData(keys.chat(chatId), { pages: [page], pageParams: [undefined] })
  const encode = (event: GenerateEvent) => `data: ${JSON.stringify(event)}\n\n`
  const start = encode({ type: 'start', userMessage: user, assistantMessage: streaming })
  let resumed!: () => void
  const reconnecting = new Promise<void>((resolve) => {
    resumed = resolve
  })
  let respond!: (response: Response) => void
  const fetchMock = spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(`${start}data: {\n\n`))
    .mockImplementationOnce(
      Object.assign(
        () =>
          new Promise<Response>((resolve) => {
            respond = resolve
            resumed()
          }),
        { preconnect: globalThis.fetch.preconnect },
      ),
    )
  const previousCancel = globalThis.cancelAnimationFrame
  globalThis.cancelAnimationFrame = () => {}
  const events: CommandEvent[] = []
  const off = onCommandEvent((event) => events.push(event))
  try {
    const sending = runGeneration(qc, chatId, { mode: 'send', text: user.content, images: [] }, 1)
    await reconnecting
    let idle = false
    const waiting = waitForGenerationIdle(chatId).then(() => {
      idle = true
    })
    await Promise.resolve()
    expect(idle).toBe(false)
    expect(events).toEqual([])
    const cache = () => qc.getQueryData<{ pages: ChatPage[] }>(keys.chat(chatId))
    expect(cache()?.pages[0]?.generating).toBe(true)
    respond(new Response(start + encode({ type: 'done', message: assistant }) + encode({ type: 'complete' })))
    await sending
    await waiting
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/${chatId}/generate`)
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(`/${chatId}/stream`)
    expect(flattenPages(cache())).toEqual([root, user, assistant])
    expect(cache()?.pages[0]?.generating).toBe(false)
    expect(events).toEqual([
      { type: 'onUser', chatId, depth: 1 },
      { type: 'onAi', chatId, depth: 1, messages: [assistant] },
    ])
  } finally {
    respond?.(new Response(encode({ type: 'complete' })))
    off()
    fetchMock.mockRestore()
    globalThis.cancelAnimationFrame = previousCancel
    qc.clear()
  }
})

test('流中的祖先状态更新保留已经追加的工具结果', async () => {
  const qc = new QueryClient()
  const chatId = 'tool-aborted-in-stream'
  const root = { ...message('user', 'user', null), chatId }
  const assistant = { ...message('assistant', 'assistant', root.id), chatId }
  const tool = { ...message('tool', 'tool', assistant.id), chatId }
  const aborted = { ...assistant, status: 'aborted' } as const
  const page = { messages: [root], chat: { activeLeafId: root.id } } as ChatPage
  qc.setQueryData(keys.chat(chatId), { pages: [page], pageParams: [undefined] })
  const events: GenerateEvent[] = [
    { type: 'start', assistantMessage: { ...assistant, status: 'streaming' } },
    { type: 'done', message: assistant },
    { type: 'message', message: tool },
    { type: 'message', message: aborted },
    { type: 'complete' },
  ]
  const fetchMock = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')),
  )
  const getPage = spyOn(api, 'getChatPage').mockResolvedValue(page)
  const previousCancel = globalThis.cancelAnimationFrame
  globalThis.cancelAnimationFrame = () => {}
  try {
    await runGeneration(qc, chatId, { mode: 'trigger' })
    expect(flattenPages(qc.getQueryData(keys.chat(chatId)))).toEqual([root, aborted, tool])
  } finally {
    getPage.mockRestore()
    fetchMock.mockRestore()
    globalThis.cancelAnimationFrame = previousCancel
    qc.clear()
  }
})
