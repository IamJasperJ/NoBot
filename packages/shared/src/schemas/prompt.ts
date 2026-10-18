import type { WIActivation } from './lorebook'
import type { PromptRole } from './message'

/** 发给模型的一条消息（OpenAI 格式） */
export interface ChatMessage {
  role: PromptRole | 'tool'
  content: string
  /** namesBehavior = completion 时使用 */
  name?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
  /**
   * 附带的图片（附件 id）。content 仍然只放文字；后端发请求前把 content + images
   * 转成 OpenAI 的多模态格式（content 数组：text + image_url）。
   */
  images?: string[]
}

/** 组装报告里的一个片段：说明这段内容从哪来、占多少 token */
export interface PromptSegment {
  /** 来源：预设条目 id（main / char_description / 自定义 id …）、history、world_info、author_note、nudge 等 */
  source: string
  /** 给人看的来源名 */
  label: string
  /** 稳定的显示代码；旧日志缺省时使用原始 label。 */
  labelCode?: string
  labelParams?: Record<string, string>
  role: ChatMessage['role']
  content: string
  tokens: number
  /** 历史消息对应的消息 id */
  messageId?: string
  /** 按深度插入的片段，记录深度 */
  depth?: number
}

export interface BuildReport {
  segments: PromptSegment[]
  totalTokens: number
  /** 可用于 Prompt 的预算（上下文长度 - 回复长度 - 余量） */
  budget: number
  /** 历史消息一共多少条、保留了多少条 */
  historyTotal: number
  historyKept: number
  /** 激活路径上被「排除于上下文」跳过的消息条数（由后端组装时填写，core 的 buildPrompt 填 0） */
  excludedCount: number
  /** 因当前未启用而省略的工具调用数量（不重复计算结果消息）。 */
  omittedToolCalls: number
  /** 世界书扫描结果（包括没插入的条目和原因） */
  worldInfo: WIActivation[]
}

export interface PromptPreview {
  messages: ChatMessage[]
  report: BuildReport
}
