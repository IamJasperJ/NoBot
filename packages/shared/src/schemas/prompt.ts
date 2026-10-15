import type { MessageRole } from './message'

/** 发给模型的一条消息（OpenAI 格式） */
export interface ChatMessage {
  role: MessageRole
  content: string
}

/** 组装报告里的一个片段：说明这段内容从哪来、占多少 token */
export interface PromptSegment {
  /** 来源，比如 'main' / 'char_description' / 'history' / 'post_history' */
  source: string
  role: MessageRole
  content: string
  tokens: number
  /** 历史消息对应的消息 id */
  messageId?: string
}

export interface BuildReport {
  segments: PromptSegment[]
  totalTokens: number
  /** 可用于 Prompt 的预算（上下文长度 - 回复长度 - 余量） */
  budget: number
  /** 历史消息一共多少条、保留了多少条 */
  historyTotal: number
  historyKept: number
}

export interface PromptPreview {
  messages: ChatMessage[]
  report: BuildReport
}
