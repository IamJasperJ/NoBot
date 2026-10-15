import { z } from 'zod'

/** 发言方 */
export const messageRoleSchema = z.enum(['user', 'assistant', 'system'])
export type MessageRole = z.infer<typeof messageRoleSchema>

/** 生成状态：生成到一半崩溃也能看到已生成的部分 */
export const messageStatusSchema = z.enum(['done', 'streaming', 'error', 'aborted'])
export type MessageStatus = z.infer<typeof messageStatusSchema>

/** 消息的附加信息，存成 json */
export interface MessageMeta {
  model?: string
  finishReason?: string
  usage?: { promptTokens?: number; completionTokens?: number }
  durationMs?: number
  /** DeepSeek 等模型返回的思考过程 */
  reasoning?: string
  /** 生成失败时的错误信息 */
  error?: string
}

/** 前端拿到的消息。swipe 信息由后端根据兄弟节点算好 */
export interface MessageDTO {
  id: string
  chatId: string
  parentId: string | null
  role: MessageRole
  content: string
  status: MessageStatus
  meta: MessageMeta
  createdAt: number
  /** 在兄弟节点中的序号，从 1 开始 */
  swipeIndex: number
  /** 兄弟节点总数（含自己） */
  swipeCount: number
}

export const editMessageInput = z.object({
  content: z.string(),
})
export type EditMessageInput = z.infer<typeof editMessageInput>
