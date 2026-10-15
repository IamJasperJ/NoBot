import { z } from 'zod'
import type { MessageDTO } from './message'

export interface ChatSummary {
  id: string
  characterId: string
  title: string
  updatedAt: number
}

export interface ChatDTO extends ChatSummary {
  personaId: string | null
  activeLeafId: string | null
  apiPresetId: string | null
  authorNote: string
  authorNoteDepth: number
  createdAt: number
}

/** 打开会话时返回的数据：会话信息 + 激活路径上的一页消息 */
export interface ChatPage {
  chat: ChatDTO
  /** 按从旧到新排列 */
  messages: MessageDTO[]
  /** 更早的消息是否还有 */
  hasMore: boolean
  /** 当前会话是否有正在进行的生成 */
  generating: boolean
}

export const createChatInput = z.object({
  characterId: z.string(),
  /** 用第几个开场白：0 是 first_mes，1 起是 alternate_greetings */
  greetingIndex: z.number().int().min(0).default(0),
})
export type CreateChatInput = z.input<typeof createChatInput>

export const updateChatInput = z.object({
  title: z.string().trim().min(1).optional(),
  apiPresetId: z.string().nullable().optional(),
  authorNote: z.string().optional(),
  authorNoteDepth: z.number().int().min(0).optional(),
})
export type UpdateChatInput = z.infer<typeof updateChatInput>

/**
 * 发起生成：
 * - send：先插入用户消息，再生成回复
 * - regenerate：在 targetId 的父节点下生成一个新的 swipe
 */
export const generateInput = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('send'), text: z.string() }),
  z.object({ mode: z.literal('regenerate'), targetId: z.string() }),
])
export type GenerateInput = z.infer<typeof generateInput>

/** 左右切换 swipe */
export const swipeInput = z.object({
  messageId: z.string(),
  direction: z.union([z.literal(-1), z.literal(1)]),
})
export type SwipeInput = z.infer<typeof swipeInput>
