import type { ApiParams, ChatMessage } from '@ai-parter/shared'
import { parseSSE } from '@ai-parter/shared'

/**
 * OpenAI 兼容接口的客户端。DeepSeek、OpenRouter、各类中转站都走这里。
 * 以后接 Claude 原生接口、Gemini 时，再抽一个统一的 LLMProvider 接口。
 */

export interface StreamOptions {
  baseUrl: string
  apiKey: string
  model: string
  params: ApiParams
  messages: ChatMessage[]
  signal: AbortSignal
}

/** 流式输出的一个分片，字段都是可选的 */
export interface StreamChunk {
  text?: string
  /** DeepSeek 等模型的思考过程 */
  reasoning?: string
  finishReason?: string
  usage?: { promptTokens?: number; completionTokens?: number }
}

export class LlmError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
  }
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
  detail = String(detail).slice(0, 300)

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

export async function* streamChatCompletion(opts: StreamOptions): AsyncGenerator<StreamChunk> {
  const { extra, ...params } = opts.params
  const url = endpoint(opts.baseUrl, '/chat/completions')

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: headers(opts.apiKey),
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        // 让接口在最后一个分片里带上 token 用量
        stream_options: { include_usage: true },
        ...params,
        ...extra,
      }),
      signal: opts.signal,
    })
  } catch (e) {
    throw toNetworkError(e, url)
  }

  if (!res.ok) throw await toLlmError(res)
  if (!res.body) throw new LlmError('EMPTY', '模型接口没有返回内容')

  // 少数接口不支持流式，会直接返回完整 JSON
  if (res.headers.get('content-type')?.includes('application/json')) {
    const json: any = await res.json()
    const choice = json?.choices?.[0]
    yield {
      text: choice?.message?.content ?? '',
      reasoning: choice?.message?.reasoning_content ?? undefined,
      finishReason: choice?.finish_reason,
      usage: mapUsage(json?.usage),
    }
    return
  }

  for await (const msg of parseSSE(res.body)) {
    if (msg.data === '[DONE]') return
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
    if (choice?.finish_reason) chunk.finishReason = choice.finish_reason
    if (json?.usage) chunk.usage = mapUsage(json.usage)
    if (Object.keys(chunk).length > 0) yield chunk
  }
}

function mapUsage(usage: any): StreamChunk['usage'] {
  if (!usage) return undefined
  return { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
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
