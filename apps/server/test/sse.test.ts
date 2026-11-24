import { expect, test } from 'bun:test'
import { parseSSE } from '@nobot/shared'

test('SSE 支持混合换行、跨块 CRLF 和 UTF-8，保留没有换行的最后一行', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\nevent: delta\r\ndata: 中文\rdata: second\r\rdata: tail')
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  })
  const events = []
  for await (const event of parseSSE(stream)) events.push(event)
  expect(events).toEqual([
    { event: 'delta', data: '中文\nsecond' },
    { event: 'message', data: 'tail' },
  ])
})

test('在终止事件后提前停止时取消上游并释放读锁', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
    },
    cancel() {
      cancelled = true
    },
  })
  for await (const event of parseSSE(stream)) {
    expect(event.data).toBe('[DONE]')
    break
  }
  expect(cancelled).toBe(true)
  expect(stream.locked).toBe(false)
})
