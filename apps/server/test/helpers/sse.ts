import { type GenerateEvent, parseSSE } from '@nobot/shared'

/** 可选观察器用于在流尚未结束时同步中止或重新连接。 */
export async function readSSE(response: Response, onEvent?: (event: GenerateEvent) => void): Promise<GenerateEvent[]> {
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    throw new Error(`预期 SSE 响应，实际 ${response.status}：${await response.text()}`)
  }
  const events: GenerateEvent[] = []
  // 流缺少结束或后端挂起时及时失败，避免清理阶段无限等待。
  const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
    signal: AbortSignal.timeout(5000),
  })
  for await (const frame of parseSSE(bounded)) {
    const event = JSON.parse(frame.data) as GenerateEvent
    if (frame.event !== event.type) throw new Error('SSE 事件名与数据类型不一致')
    events.push(event)
    onEvent?.(event)
  }
  return events
}

/** 短间隔检查真实条件，超时明确报错，不依赖机器速度猜测完成时间。 */
export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`等待条件超时（${timeoutMs} 毫秒）`)
    await Bun.sleep(5)
  }
}
