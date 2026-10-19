import { parseSSE, type ToolCall } from '@nobot/shared'
import { type Json, request, upstreamError } from '../common'
import type { CompletionRequest, StreamChunk } from '../types'
import { contentParts } from './anthropic'

export function googleBody(body: Json, vertex = false): Json {
  const system: Json[] = []
  const contents: { role: string; parts: Json[] }[] = []
  const names = new Map<string, string>()
  let leading = true
  for (const message of (body.messages ?? []) as Json[]) {
    if (leading && message.role === 'system') {
      system.push(...contentParts(message.content, true))
      continue
    }
    leading = false
    const role = message.role === 'assistant' ? 'model' : 'user'
    let parts = contentParts(message.content, true)
    if (message.name && typeof message.content === 'string')
      parts = contentParts(`${message.name}: ${message.content}`, true)
    for (const call of message.tool_calls ?? []) {
      names.set(call.id, call.function.name)
      parts.push({
        functionCall: { name: call.function.name, args: JSON.parse(call.function.arguments || '{}') },
        // 共享契约没有保存签名的字段，Gemini 3 的历史工具调用使用官方兼容占位。
        ...(String(body.model).includes('gemini-3') ? { thoughtSignature: 'skip_thought_signature_validator' } : {}),
      })
    }
    if (message.role === 'tool') {
      let response: unknown
      try {
        response = JSON.parse(message.content)
      } catch {
        response = message.content
      }
      parts = [
        {
          functionResponse: {
            name: names.get(message.tool_call_id) ?? message.name ?? message.tool_call_id,
            response:
              response && typeof response === 'object' && !Array.isArray(response) ? response : { result: response },
          },
        },
      ]
    }
    if (!parts.length) continue
    const last = contents.at(-1)
    if (last?.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Continue.' }] })
  const generationConfig: Json = {}
  for (const [from, to] of Object.entries({
    temperature: 'temperature',
    top_p: 'topP',
    top_k: 'topK',
    max_tokens: 'maxOutputTokens',
    stop: 'stopSequences',
  })) {
    if (body[from] !== undefined)
      generationConfig[to] = from === 'stop' && typeof body[from] === 'string' ? [body[from]] : body[from]
  }
  if (body.reasoning_effort && body.reasoning_effort !== 'auto') {
    const ratio: Record<string, number> = { minimal: 0, low: 0.1, medium: 0.25, high: 0.5 }
    const model = String(body.model)
    const minimum = model.includes('pro') ? 128 : model.includes('flash-lite') ? 512 : 0
    const maximum = model.includes('pro') ? 32768 : 24576
    const budget = Math.max(
      minimum,
      Math.min(maximum, Math.floor((body.max_tokens ?? 4096) * (ratio[body.reasoning_effort] ?? 0.25))),
    )
    generationConfig.thinkingConfig = String(body.model).includes('gemini-3')
      ? {
          thinkingLevel: body.reasoning_effort === 'minimal' ? 'minimal' : body.reasoning_effort,
          includeThoughts: true,
        }
      : { thinkingBudget: budget, includeThoughts: true }
  } else if (body.include_reasoning) generationConfig.thinkingConfig = { includeThoughts: true }
  const result: Json = {
    contents,
    generationConfig,
    safetySettings: [
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_DANGEROUS_CONTENT',
      'HARM_CATEGORY_CIVIC_INTEGRITY',
      ...(vertex
        ? [
            'HARM_CATEGORY_IMAGE_HATE',
            'HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT',
            'HARM_CATEGORY_IMAGE_HARASSMENT',
            'HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT',
            'HARM_CATEGORY_JAILBREAK',
          ]
        : []),
    ].map((category) => ({ category, threshold: 'OFF' })),
  }
  if (system.length) result.systemInstruction = { parts: system }
  if (body.tools?.length)
    result.tools = [
      {
        functionDeclarations: body.tools.map((tool: Json) => ({
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
      },
    ]
  if (body.tool_choice)
    result.toolConfig = {
      functionCallingConfig:
        typeof body.tool_choice === 'object'
          ? { mode: 'ANY', allowedFunctionNames: [body.tool_choice.function.name] }
          : { mode: body.tool_choice === 'required' ? 'ANY' : body.tool_choice === 'none' ? 'NONE' : 'AUTO' },
    }
  return result
}

/** 同一响应解析器供 AI Studio 和 Vertex 使用；调用 id 跨分片保持唯一。 */
export async function* googleCompletion(
  req: CompletionRequest,
  url: string,
  headers: Headers,
): AsyncGenerator<StreamChunk> {
  const res = await request(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(googleBody(req.body, req.connection.provider === 'vertexai')),
    signal: req.signal,
  })
  const calls: ToolCall[] = []
  const decode = (json: Json): StreamChunk => {
    upstreamError(json)
    const candidate = json.candidates?.[0]
    const parts: Json[] = candidate?.content?.parts ?? []
    for (const part of parts)
      if (part.functionCall)
        calls.push({
          id: part.functionCall.id ?? `google_call_${calls.length}`,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        })
    return {
      text: parts
        .filter((p) => !p.thought)
        .map((p) => p.text ?? '')
        .join(''),
      reasoning:
        parts
          .filter((p) => p.thought)
          .map((p) => p.text ?? '')
          .join('') || undefined,
      finishReason: candidate?.finishReason ?? json.promptFeedback?.blockReason,
      ...(json.usageMetadata
        ? {
            usage: {
              promptTokens: json.usageMetadata.promptTokenCount,
              completionTokens:
                (json.usageMetadata.candidatesTokenCount ?? 0) + (json.usageMetadata.thoughtsTokenCount ?? 0),
            },
          }
        : {}),
    }
  }
  if (!req.body.stream || res.headers.get('content-type')?.includes('application/json')) {
    const json = await res.json()
    for (const item of Array.isArray(json) ? json : [json]) yield decode(item)
  } else {
    for await (const event of parseSSE(res.body!)) {
      let json: Json
      try {
        json = JSON.parse(event.data)
      } catch {
        continue
      }
      yield decode(json)
    }
  }
  if (calls.length) yield { toolCalls: calls }
}
