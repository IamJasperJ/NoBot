import type { ChatMessage, SamplerSettings, ToolCall } from '@ai-parter/shared'
import { parseSSE } from '@ai-parter/shared'

/**
 * OpenAI 兼容接口的客户端。DeepSeek、OpenRouter、各类中转站都走这里。
 * 以后接 Claude 原生接口、Gemini 时，再抽一个统一的 LLMProvider 接口。
 */

export interface CompletionRequest {
  baseUrl: string
  apiKey: string
  /** 完整的请求体（由 buildRequestBody 生成，同时会记进日志） */
  body: Record<string, unknown>
  signal: AbortSignal
}

/** 流式输出的一个分片，字段都是可选的 */
export interface StreamChunk {
  text?: string
  /** DeepSeek 等模型的思考过程 */
  reasoning?: string
  finishReason?: string
  usage?: { promptTokens?: number; completionTokens?: number }
  /** 模型发起的工具调用（流结束时一次性给出完整的调用） */
  toolCalls?: ToolCall[]
}

export class LlmError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

/**
 * 根据生成预设的采样参数生成请求体。
 * 非 OpenAI 标准的参数（top_k、min_p、top_a、repetition_penalty）只在不是默认值时才发送，
 * 因为 OpenAI 官方等接口遇到不认识的参数会直接报错。
 */
export function buildRequestBody(opts: {
  model: string
  messages: ChatMessage[]
  samplers: SamplerSettings
  tools?: unknown[]
}): Record<string, unknown> {
  const s = opts.samplers
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: s.stream,
    max_tokens: s.maxTokens,
    temperature: s.temperature,
    top_p: s.topP,
    frequency_penalty: s.frequencyPenalty,
    presence_penalty: s.presencePenalty,
  }
  if (s.stream) body.stream_options = { include_usage: true }
  if (s.topK > 0) body.top_k = s.topK
  if (s.minP > 0) body.min_p = s.minP
  if (s.topA > 0) body.top_a = s.topA
  if (s.repetitionPenalty !== 1) body.repetition_penalty = s.repetitionPenalty
  if (s.seed >= 0) body.seed = s.seed
  if (s.stop.length > 0) body.stop = s.stop.slice(0, 4) // OpenAI 最多 4 个
  if (s.reasoningEffort !== 'auto') body.reasoning_effort = s.reasoningEffort
  if (s.requestReasoning) body.include_reasoning = true
  if (opts.tools && opts.tools.length > 0) body.tools = opts.tools

  // 额外参数：用户写的 JSON 原样合并，可以覆盖上面的任何字段
  if (s.extraBody.trim()) {
    try {
      const extra = JSON.parse(s.extraBody)
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(body, extra)
    } catch {
      throw new LlmError('BAD_EXTRA_BODY', '生成预设里的「额外请求参数」不是合法的 JSON 对象')
    }
  }
  return body
}

function endpoint(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

function headers(apiKey: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) h.Authorization = `Bearer ${apiKey}`
  return h
}

/** 把上游的 HTTP 错误翻译成看得懂的提示 */
async function toLlmError(res: Response): Promise<LlmError> {
  let detail = ''
  try {
    const text = await res.text()
    try {
      const json = JSON.parse(text)
      detail = json?.error?.message ?? json?.message ?? text
    } catch {
      detail = text
    }
  } catch {
    // 读不出响应体就算了
  }
  detail = String(detail).slice(0, 500)

  const hint: Record<number, string> = {
    400: '请求被拒绝，可能是参数或模型不支持',
    401: 'API Key 无效或已过期',
    403: '没有权限访问这个模型',
    404: '接口地址或模型名不存在',
    429: '请求太频繁或额度用完了',
  }
  const base = hint[res.status] ?? (res.status >= 500 ? '模型服务暂时不可用' : '请求失败')
  return new LlmError(`HTTP_${res.status}`, detail ? `${base}（${res.status}）：${detail}` : `${base}（${res.status}）`)
}

/** fetch 本身失败（断网、域名错误、被中止） */
function toNetworkError(e: unknown, url: string): Error {
  if (e instanceof DOMException && e.name === 'AbortError') return e
  const host = (() => {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  })()
  return new LlmError('NETWORK', `无法连接到 ${host}：${e instanceof Error ? e.message : String(e)}`)
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
export async function* chatCompletion(req: CompletionRequest): AsyncGenerator<StreamChunk> {
  const url = endpoint(req.baseUrl, '/chat/completions')
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headers(req.apiKey),
      body: JSON.stringify(req.body),
      signal: req.signal,
    })
  } catch (e) {
    throw toNetworkError(e, url)
  }
  if (!res.ok) throw await toLlmError(res)
  if (!res.body) throw new LlmError('EMPTY', '模型接口没有返回内容')

  // 非流式（或接口不支持流式、直接返回了 JSON）
  if (!req.body.stream || res.headers.get('content-type')?.includes('application/json')) {
    const json: any = await res.json()
    if (json?.error) throw new LlmError('UPSTREAM', `模型返回错误：${json.error.message ?? JSON.stringify(json.error)}`)
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
      throw new LlmError('UPSTREAM', `模型返回错误：${json.error.message ?? JSON.stringify(json.error)}`)
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

/** 测试连接并拉取模型列表 */
export async function listModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const url = endpoint(baseUrl, '/models')
  let res: Response
  try {
    res = await fetch(url, { headers: headers(apiKey), signal: AbortSignal.timeout(15_000) })
  } catch (e) {
    throw toNetworkError(e, url)
  }
  if (!res.ok) throw await toLlmError(res)
  const json: any = await res.json()
  const list: unknown[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []
  return list
    .map((m) => (typeof m === 'string' ? m : (m as { id?: unknown })?.id))
    .filter((id): id is string => typeof id === 'string')
    .sort()
}
