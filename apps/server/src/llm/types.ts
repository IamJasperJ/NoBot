import type { ToolCall } from '@nobot/shared'
export interface LlmConnection {
  provider: string
  baseUrl: string
  apiKey: string
  headers: Record<string, string>
  options: Record<string, string>
}
export interface CompletionRequest {
  connection: LlmConnection
  /** 原始 OpenAI 请求体，同时用于日志；适配器不得修改它。 */
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
