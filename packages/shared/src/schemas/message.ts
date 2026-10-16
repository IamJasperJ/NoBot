import { z } from 'zod'

/** 发言方。tool 是工具调用的结果 */
export const messageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool'])
export type MessageRole = z.infer<typeof messageRoleSchema>

/** Prompt 条目、世界书条目可选的角色（不含 tool） */
export const promptRoleSchema = z.enum(['system', 'user', 'assistant'])
export type PromptRole = z.infer<typeof promptRoleSchema>

/** 生成状态：生成到一半崩溃也能看到已生成的部分 */
export const messageStatusSchema = z.enum(['done', 'streaming', 'error', 'aborted'])
export type MessageStatus = z.infer<typeof messageStatusSchema>

/** 模型发起的一次工具调用 */
export interface ToolCall {
  id: string
  name: string
  /** JSON 字符串，原样保存模型给的参数 */
  arguments: string
}

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
  /** 对应的请求日志，用来查看这条消息当时发送的完整 Prompt */
  logId?: string
  /** 发送时的名字（用户人设名 / 角色名），角色被删除后仍能显示 */
  name?: string
  /** 助手消息里模型发起的工具调用 */
  toolCalls?: ToolCall[]
  /** tool 消息：对应哪一次调用 */
  toolCallId?: string
  toolName?: string
  /** tool 消息：这次调用对会话变量的修改，沿激活路径累加就是当前的跑团状态 */
  varsPatch?: Record<string, unknown>
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
  /** 群聊里是哪个角色说的（单人会话里就是那个角色） */
  speakerId: string | null
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
