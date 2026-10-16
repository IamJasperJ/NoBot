import { z } from 'zod'
import type { GroupDTO } from './group'
import type { MessageDTO } from './message'

export interface ChatSummary {
  id: string
  /** 单人会话的角色；群聊为 null */
  characterId: string | null
  /** 群聊的群组；单人会话为 null */
  groupId: string | null
  title: string
  updatedAt: number
}

export interface ChatDTO extends ChatSummary {
  personaId: string | null
  activeLeafId: string | null
  /** 连接配置，为空则用全局默认 */
  apiPresetId: string | null
  /** 生成预设，为空则用全局默认 */
  promptPresetId: string | null
  authorNote: string
  authorNoteDepth: number
  authorNoteRole: 'system' | 'user' | 'assistant'
  /** 挂在这个会话上的世界书 */
  lorebookIds: string[]
  createdAt: number
}

/** 打开会话时返回的数据：会话信息 + 激活路径上的一页消息 */
export interface ChatPage {
  chat: ChatDTO
  /** 群聊时附带群组信息 */
  group: GroupDTO | null
  /** 按从旧到新排列 */
  messages: MessageDTO[]
  /** 更早的消息是否还有 */
  hasMore: boolean
  /** 当前会话是否有正在进行的生成 */
  generating: boolean
  /** 沿激活路径累加工具调用得到的会话变量（跑团状态） */
  vars: Record<string, unknown>
}

export const createChatInput = z
  .object({
    characterId: z.string().optional(),
    groupId: z.string().optional(),
    /** 单人会话用第几个开场白：0 是 first_mes，1 起是 alternate_greetings */
    greetingIndex: z.number().int().min(0).default(0),
  })
  .refine((v) => !!v.characterId !== !!v.groupId, '必须且只能指定角色或群组之一')
export type CreateChatInput = z.input<typeof createChatInput>

export const updateChatInput = z.object({
  title: z.string().trim().min(1).optional(),
  personaId: z.string().nullable().optional(),
  apiPresetId: z.string().nullable().optional(),
  promptPresetId: z.string().nullable().optional(),
  authorNote: z.string().optional(),
  authorNoteDepth: z.number().int().min(0).optional(),
  authorNoteRole: z.enum(['system', 'user', 'assistant']).optional(),
  lorebookIds: z.array(z.string()).optional(),
})
export type UpdateChatInput = z.infer<typeof updateChatInput>

/**
 * 发起生成：
 * - send：先插入用户消息，再生成回复（text 为空时用预设里的「空消息替代文本」）
 * - regenerate：在 targetId 的父节点下生成一个新的 swipe
 * - continue：接着 targetId（必须是当前叶子上的角色回复）往下写
 * - trigger：不发用户消息，直接让角色发言；群聊里可以指定 speakerId（强制发言）
 */
export const generateInput = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('send'), text: z.string() }),
  z.object({ mode: z.literal('regenerate'), targetId: z.string() }),
  z.object({ mode: z.literal('continue'), targetId: z.string() }),
  z.object({ mode: z.literal('trigger'), speakerId: z.string().optional() }),
])
export type GenerateInput = z.infer<typeof generateInput>

/** 左右切换 swipe */
export const swipeInput = z.object({
  messageId: z.string(),
  direction: z.union([z.literal(-1), z.literal(1)]),
})
export type SwipeInput = z.infer<typeof swipeInput>

/** 从某条消息开分支：复制到这条为止的路径，成为一个新会话 */
export const branchInput = z.object({ messageId: z.string() })
