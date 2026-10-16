import { spyOn } from 'bun:test'
import type { ChatMessage, ToolCall } from '@ai-parter/shared'

export interface MockRequest extends Record<string, unknown> {
  messages: ChatMessage[]
  stream: boolean
}
export type MockReply =
  | { text: string; reasoning?: string; delayMs?: number }
  | { toolCalls: ToolCall[] }
  | { status: 401 | 500; error: string }
export type MockScript = (body: MockRequest) => MockReply

/** 使用真实 HTTP 流，覆盖客户端的分片解析和中止逻辑。 */
export function mockLlm() {
  const requests: MockRequest[] = []
  const receivedHeaders: Headers[] = []
  let script: MockScript = () => ({ text: '模拟回复' })
  const respond = async (request: Request) => {
    receivedHeaders.push(new Headers(request.headers))
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/v1/models') {
      return Response.json({ data: [{ id: 'mock-one' }, { id: 'mock-two' }] })
    }
    if (request.method !== 'POST' || path !== '/v1/chat/completions') {
      return new Response('接口不存在', { status: 404 })
    }
    const body = (await request.json()) as MockRequest
    requests.push(body)
    const reply = script(body)
    if ('status' in reply) return Response.json({ error: { message: reply.error } }, { status: reply.status })
    const calls = 'toolCalls' in reply ? reply.toolCalls : []
    const finishReason = calls.length ? 'tool_calls' : 'stop'
    if (!body.stream) {
      return Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'text' in reply ? reply.text : null,
              ...('reasoning' in reply ? { reasoning_content: reply.reasoning } : {}),
              ...(calls.length
                ? {
                    tool_calls: calls.map((call) => ({
                      id: call.id,
                      type: 'function',
                      function: { name: call.name, arguments: call.arguments },
                    })),
                  }
                : {}),
            },
            finish_reason: finishReason,
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      })
    }
    const deltas: Record<string, unknown>[] = []
    if ('text' in reply) {
      for (const char of reply.reasoning ?? '') deltas.push({ reasoning_content: char })
      for (const char of reply.text) deltas.push({ content: char })
    } else {
      // 名称和参数都拆成三段，防止只覆盖参数完整到达的理想情况。
      for (let part = 0; part < 3; part++) {
        const slice = (value: string) =>
          value.slice(Math.floor((value.length * part) / 3), Math.floor((value.length * (part + 1)) / 3))
        deltas.push({
          tool_calls: calls.map((call, index) => ({
            index,
            ...(part === 0 ? { id: call.id, type: 'function' } : {}),
            function: { name: slice(call.name), arguments: slice(call.arguments) },
          })),
        })
      }
    }
    const encoder = new TextEncoder()
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        request.signal.addEventListener(
          'abort',
          () => {
            cancelled = true
            controller.error(new DOMException('请求已中止', 'AbortError'))
          },
          { once: true },
        )
        const send = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
        try {
          for (const delta of deltas) {
            if (cancelled || request.signal.aborted) break
            send({ choices: [{ delta }] })
            if ('delayMs' in reply && reply.delayMs) await Bun.sleep(reply.delayMs)
          }
          if (!cancelled) {
            send({
              choices: [{ delta: {}, finish_reason: finishReason }],
              usage: { prompt_tokens: 12, completion_tokens: 8 },
            })
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          }
        } catch (error) {
          if (!cancelled && !request.signal.aborted) controller.error(error)
        }
      },
      cancel() {
        cancelled = true
      },
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const server = process.env.MOCK_LLM_FETCH ? undefined : Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: respond })
  const mocked = process.env.MOCK_LLM_FETCH
    ? spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => respond(new Request(input, init)),
          { preconnect: fetch.preconnect },
        ),
      )
    : undefined
  return {
    url: `http://127.0.0.1:${server?.port ?? 12345}/v1`,
    requests,
    receivedHeaders,
    setScript(next: MockScript) {
      script = next
    },
    stop() {
      mocked?.mockRestore()
      return server?.stop(true)
    },
  }
}
