import { expect, spyOn, test } from 'bun:test'
import type { ChatPage, GenerateEvent, MessageDTO } from '@ai-parter/shared'
import { QueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { keys } from '../api/queries'
import { runGeneration, waitForGenerationIdle } from '../features/chat/generate'
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
