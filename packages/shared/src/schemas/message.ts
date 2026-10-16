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
  /**
   * 消息附带的图片（附件 id 和原图尺寸），文件在 data/assets/attachments/。
   * 用户消息的图片会发给模型（看图）；其他角色的图片（比如生成的图片）只显示，不发给模型
   */
  images?: AttachmentDTO[]
  /**
   * 有多张图片时当前显示第几张（从 0 开始，默认最后一张）。
   * 图片生成扩展的「重新生成」会追加一张新图并切过去，像酒馆的图片 swipe 一样左右切换
   */
  imageIndex?: number
  /** 这条消息上的图片生成任务（图片生成扩展写入）。生成完成后图片追加进 images */
  imageGen?: ImageGenMeta
}

/** 图片生成任务的状态，界面据此显示占位框 / 错误 / 重试 */
export interface ImageGenMeta {
  /** pending：生成中（显示占位框）；done：完成；error：失败 */
  status: 'pending' | 'done' | 'error'
  /**
   * pending 时处在哪个阶段，占位框据此显示「正在写提示词… / 等待确认… / 排队中（第 n 位）/ 生成中… / 保存中…」。
   * 每个阶段对用户可见，避免长时间只看到转圈
   */
  stage?: 'prompt' | 'confirm' | 'queued' | 'generating' | 'saving'
  /** stage 为 queued 时排在第几位（从 1 开始） */
  queuePosition?: number
  /** 生成类型，如 character、last、background，见图片生成扩展 */
  mode: string
  /** 最终发给图片接口的提示词（由模型写好后才有） */
  prompt?: string
  error?: string
  /** 发给图片接口的负面提示词 */
  negative?: string
  /** 实际使用的种子（-1 随机时记录随机出来的值） */
  seed?: number
  /**
   * 这条图片消息进 Prompt 时的文字（比如「[艾莉丝 发送了一张图片：...]」），由生成方按模板渲染好存在这里。
   * 没有时用默认文字
   */
  caption?: string
  /** true 时这条图片消息不进 Prompt（对应酒馆按来源设置的「聊天消息可见性」） */
  hidden?: boolean
  /** 占位框按这个宽高比显示，避免图片出来时页面跳动 */
  width?: number
  height?: number
}

/** 上传的图片附件 */
export interface AttachmentDTO {
  id: string
  /** 显示用的地址 */
  url: string
  width: number
  height: number
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
