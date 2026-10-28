import type { ToolCall } from '@nobot/shared'
import { parseSSE } from '@nobot/shared'
import { t } from '../../i18n'
import { endpoint, headers, toLlmError, toNetworkError } from '../common'
import { toolImageFallback } from '../tool-images'
import { type CompletionRequest, type LlmConnection, LlmError, type StreamChunk } from '../types'

export function openaiBase(c: LlmConnection): string {
  return c.provider === 'workers_ai'
    ? endpoint(c.baseUrl, `/${encodeURIComponent(c.options.accountId ?? '')}/ai/v1`)
    : c.baseUrl
}
export function openaiHeaders(c: LlmConnection): Headers {
  return headers(c.apiKey, {
    ...(c.provider === 'openrouter' ? { 'HTTP-Referer': 'http://localhost:3000', 'X-Title': 'NoBot' } : {}),
    ...c.headers,
  })
}
export function openaiBody(input: Record<string, unknown>, provider: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...input,
    ...(Array.isArray(input.messages) ? { messages: toolImageFallback(input.messages) } : {}),
  }
  if (['openai', 'mistralai', 'perplexity', 'cohere', 'ai21'].includes(provider)) {
    for (const key of ['top_k', 'min_p', 'top_a', 'repetition_penalty', 'include_reasoning']) delete body[key]
  }
  if (['mistralai', 'cohere', 'ai21'].includes(provider)) delete body.reasoning_effort
  if (provider === 'ai21') {
    delete body.frequency_penalty
    delete body.presence_penalty
  }
  if (provider === 'mistralai') {
    if (body.seed !== undefined) body.random_seed = body.seed
    delete body.seed
    delete body.stream_options
  }
  if (['perplexity', 'cohere', 'ai21'].includes(provider)) {
    delete body.stream_options
    delete body.seed
  }
  return body
}
function mapUsage(usage: any): StreamChunk['usage'] {
  if (!usage) return undefined
  return { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
}

/** 流式工具调用是分片到达的（按 index 拼接 id、名字、参数），这里负责拼起来 */
class ToolCallAccumulator {
  private calls: { id: string; name: string; arguments: string }[] = []
  add(deltas: any[]) {
    for (const d of deltas) {
      const i = typeof d.index === 'number' ? d.index : this.calls.length
      if (!this.calls[i]) this.calls[i] = { id: '', name: '', arguments: '' }
      const call = this.calls[i]
      if (d.id) call.id = d.id
      if (d.function?.name) call.name += d.function.name
      if (d.function?.arguments) call.arguments += d.function.arguments
    }
  }
  result(): ToolCall[] {
    return this.calls
      .filter((c) => c?.name)
      .map((c, i) => ({ id: c.id || `call_${Date.now()}_${i}`, name: c.name, arguments: c.arguments }))
  }
}

/**
 * 调用 /chat/completions。stream 为 true 时边收边产出分片；为 false 时一次性产出完整结果。
 * 工具调用在最后一个分片的 toolCalls 里给出。
 */
export async function* openaiCompletion(
  req: CompletionRequest,
  override?: { url: string; headers: Headers },
): AsyncGenerator<StreamChunk> {
  const { connection } = req
  const url = override?.url ?? endpoint(openaiBase(connection), '/chat/completions')
  const body = openaiBody(req.body, connection.provider)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: override?.headers ?? openaiHeaders(connection),
      body: JSON.stringify(body),
      signal: req.signal,
    })
  } catch (e) {
    throw toNetworkError(e, url)
  }
  if (!res.ok) throw await toLlmError(res)
  if (!res.body) throw new LlmError('EMPTY', t('模型接口没有返回内容'))

  // 非流式（或接口不支持流式、直接返回了 JSON）
  if (!req.body.stream || res.headers.get('content-type')?.includes('application/json')) {
    const json: any = await res.json()
    if (json?.error)
      throw new LlmError(
        'UPSTREAM',
        t('模型返回错误：{error}', { error: String(json.error.message ?? JSON.stringify(json.error)).slice(0, 500) }),
      )
    const choice = json?.choices?.[0]
    const acc = new ToolCallAccumulator()
    if (Array.isArray(choice?.message?.tool_calls)) acc.add(choice.message.tool_calls)
    const toolCalls = acc.result()
    yield {
      text: choice?.message?.content ?? '',
      reasoning: choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? undefined,
      finishReason: choice?.finish_reason,
      usage: mapUsage(json?.usage),
      ...(toolCalls.length ? { toolCalls } : {}),
    }
    return
  }

  const acc = new ToolCallAccumulator()
  for await (const msg of parseSSE(res.body)) {
    if (msg.data === '[DONE]') break
    let json: any
    try {
      json = JSON.parse(msg.data)
    } catch {
      continue // 有的中转站会混入非 JSON 的行，跳过
    }
    if (json?.error) {
      throw new LlmError(
        'UPSTREAM',
        t('模型返回错误：{error}', { error: String(json.error.message ?? JSON.stringify(json.error)).slice(0, 500) }),
      )
    }
    const choice = json?.choices?.[0]
    const delta = choice?.delta ?? {}
    const chunk: StreamChunk = {}
    if (typeof delta.content === 'string' && delta.content) chunk.text = delta.content
    // DeepSeek 用 reasoning_content，OpenRouter 用 reasoning
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === 'string' && reasoning) chunk.reasoning = reasoning
    if (Array.isArray(delta.tool_calls)) acc.add(delta.tool_calls)
    if (choice?.finish_reason) chunk.finishReason = choice.finish_reason
    if (json?.usage) chunk.usage = mapUsage(json.usage)
    if (Object.keys(chunk).length > 0) yield chunk
  }
  const toolCalls = acc.result()
  if (toolCalls.length) yield { toolCalls }
}
