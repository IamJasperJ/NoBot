import { parseSSE, type ToolCall } from '@nobot/shared'
import { t } from '../../i18n'
import { endpoint, type Json, request, upstreamError } from '../common'
import { type CompletionRequest, LlmError, type StreamChunk } from '../types'

/** 图片在业务层已解析为 data URL，协议层拒绝静默丢弃无法转换的附件。 */
export function imageData(url: string): { mime: string; data: string } {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(url)
  if (!match) throw new LlmError('BAD_ATTACHMENT', t('原生模型接口需要 base64 图片附件'))
  return { mime: match[1]!, data: match[2]! }
}

export function contentParts(content: unknown, google = false): Json[] {
  const parts: Json[] =
    typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  return parts.flatMap((part): Json[] => {
    if (part.type === 'text') return part.text ? [google ? { text: part.text } : { type: 'text', text: part.text }] : []
    if (part.type === 'image_url') {
      const image = imageData(part.image_url.url)
      return [
        google
          ? { inline_data: { mime_type: image.mime, data: image.data } }
          : {
              type: 'image',
              source: { type: 'base64', media_type: image.mime, data: image.data },
            },
      ]
    }
    return []
  })
}

/** 只抽出开头的系统消息，中途指令保持原时序并转换为 user。 */
export function anthropicBody(body: Json): Json {
  const system: Json[] = []
  const messages: { role: string; content: Json[] }[] = []
  let leading = true
  for (const message of (body.messages ?? []) as Json[]) {
    if (leading && message.role === 'system') {
      system.push(...contentParts(message.content))
      continue
    }
    leading = false
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    let content = contentParts(message.content)
    if (message.name && typeof message.content === 'string')
      content = contentParts(`${message.name}: ${message.content}`)
    if (message.role === 'tool')
      content = [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }]
    for (const call of message.tool_calls ?? [])
      content.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments || '{}'),
      })
    if (!content.length) continue
    const last = messages.at(-1)
    if (last?.role === role) last.content.push(...content)
    else messages.push({ role, content })
  }
  if (messages[0]?.role !== 'user') messages.unshift({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] })
  const result: Json = { model: body.model, messages, max_tokens: body.max_tokens ?? 4096, stream: !!body.stream }
  if (system.length) result.system = system
  for (const key of ['temperature', 'top_p', 'top_k']) if (body[key] !== undefined) result[key] = body[key]
  if (body.stop) result.stop_sequences = typeof body.stop === 'string' ? [body.stop] : body.stop
  if (body.tools?.length)
    result.tools = body.tools.map((tool: Json) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }))
  if (body.tool_choice)
    result.tool_choice =
      typeof body.tool_choice === 'object'
        ? { type: 'tool', name: body.tool_choice.function.name }
        : { type: body.tool_choice === 'required' ? 'any' : body.tool_choice }
  if (body.reasoning_effort && body.reasoning_effort !== 'auto') {
    const ratio: Record<string, number> = { minimal: 0, low: 0.1, medium: 0.25, high: 0.5 }
    result.max_tokens = Math.max(2048, result.max_tokens)
    result.thinking = {
      type: 'enabled',
      budget_tokens: Math.min(
        body.stream ? Number.POSITIVE_INFINITY : 21333,
        Math.max(1024, Math.floor(result.max_tokens * (ratio[body.reasoning_effort] ?? 0.25))),
      ),
    }
    // 传统 thinking 不接受采样参数与 assistant prefill，保留文本但改成 user 指令。
    for (const key of ['temperature', 'top_p', 'top_k']) delete result[key]
    if (messages.at(-1)?.role === 'assistant') messages.at(-1)!.role = 'user'
    for (let i = messages.length - 1; i > 0; i--) {
      if (messages[i]!.role === messages[i - 1]!.role) {
        messages[i - 1]!.content.push(...messages[i]!.content)
        messages.splice(i, 1)
      }
    }
  }
  const prefill = messages.at(-1)
  if (prefill?.role === 'assistant') {
    // Messages API 拒绝 prefill 的尾随空白，清理时不影响日志中的原始消息。
    while (prefill.content.at(-1)?.type === 'text') {
      const part = prefill.content.at(-1)!
      part.text = part.text.trimEnd()
      if (part.text) break
      prefill.content.pop()
    }
    if (!prefill.content.length) messages.pop()
  }
  return result
}

export function anthropicHeaders(apiKey: string, extra: Record<string, string>): Headers {
  return new Headers({
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    ...extra,
  })
}

export async function* anthropicCompletion(req: CompletionRequest): AsyncGenerator<StreamChunk> {
  const c = req.connection
  const res = await request(endpoint(c.baseUrl, '/messages'), {
    method: 'POST',
    headers: anthropicHeaders(c.apiKey, c.headers),
    body: JSON.stringify(anthropicBody(req.body)),
    signal: req.signal,
  })
  if (!req.body.stream || res.headers.get('content-type')?.includes('application/json')) {
    const json = (await res.json()) as Json
    upstreamError(json)
    const content: Json[] = json.content ?? []
    yield {
      text: content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join(''),
      reasoning:
        content
          .filter((p) => p.type === 'thinking')
          .map((p) => p.thinking)
          .join('') || undefined,
      toolCalls: content
        .filter((p) => p.type === 'tool_use')
        .map((p) => ({ id: p.id, name: p.name, arguments: JSON.stringify(p.input) })),
      usage: { promptTokens: json.usage?.input_tokens, completionTokens: json.usage?.output_tokens },
      finishReason: json.stop_reason,
    }
    return
  }
  const calls = new Map<number, ToolCall>()
  let promptTokens: number | undefined
  let completionTokens: number | undefined
  for await (const event of parseSSE(res.body!)) {
    let json: Json
    try {
      json = JSON.parse(event.data)
    } catch {
      continue
    }
    upstreamError(json)
    if (json.type === 'message_start') {
      promptTokens = json.message?.usage?.input_tokens
      completionTokens = json.message?.usage?.output_tokens
      yield { usage: { promptTokens, completionTokens } }
    }
    if (json.type === 'content_block_start') {
      const block = json.content_block
      if (block?.type === 'tool_use')
        calls.set(json.index, {
          id: block.id,
          name: block.name,
          arguments: Object.keys(block.input ?? {}).length ? JSON.stringify(block.input) : '',
        })
      if (block?.text) yield { text: block.text }
      if (block?.thinking) yield { reasoning: block.thinking }
    }
    if (json.type === 'content_block_delta') {
      if (json.delta?.text) yield { text: json.delta.text }
      if (json.delta?.thinking) yield { reasoning: json.delta.thinking }
      const call = calls.get(json.index)
      if (call && json.delta?.partial_json) call.arguments += json.delta.partial_json
    }
    if (json.type === 'message_delta') {
      completionTokens = json.usage?.output_tokens ?? completionTokens
      yield { finishReason: json.delta?.stop_reason, usage: { promptTokens, completionTokens } }
    }
  }
  if (calls.size)
    yield { toolCalls: [...calls.values()].map((call) => ({ ...call, arguments: call.arguments || '{}' })) }
}
