import { z } from 'zod'

/**
 * 群聊。群组是独立的实体，一个群组可以有多个会话（chats.group_id）。
 */

/**
 * 发言顺序：
 * - natural：被点名的角色先说；没人被点名时按「发言积极度」随机选
 * - list：按成员列表顺序每人说一次
 * - pooled：从这一轮还没说过话的人里随机选一个
 * - manual：用户发消息后不自动回复，只能手动点名
 */
export const groupActivationSchema = z.enum(['natural', 'list', 'pooled', 'manual'])
export type GroupActivation = z.infer<typeof groupActivationSchema>

/** swap：只用当前发言者的角色卡；join：把所有成员的角色卡合并发送 */
export const groupGenerationModeSchema = z.enum(['swap', 'join', 'join_include_muted'])
export type GroupGenerationMode = z.infer<typeof groupGenerationModeSchema>

export interface GroupMemberDTO {
  characterId: string
  name: string
  avatarUrl: string | null
  muted: boolean
  talkativeness: number
}

export interface GroupDTO {
  id: string
  name: string
  activation: GroupActivation
  generationMode: GroupGenerationMode
  /** 自然顺序时允许角色回应自己消息里的点名 */
  allowSelfResponses: boolean
  /** 自动模式：AI 之间自动接着聊。未实现 */
  autoMode: boolean
  /** 覆盖所有成员的场景，留空则用各自的 */
  defaultBackgroundId: string | null
  scenarioOverride: string
  members: GroupMemberDTO[]
  updatedAt: number
}

export const groupInput = z.object({
  name: z.string().trim().min(1),
  activation: groupActivationSchema.default('natural'),
  generationMode: groupGenerationModeSchema.default('swap'),
  allowSelfResponses: z.boolean().default(false),
  autoMode: z.boolean().default(false),
  scenarioOverride: z.string().default(''),
  defaultBackgroundId: z.string().nullable().default(null),
  /** 成员顺序即列表顺序 */
  members: z
    .array(z.object({ characterId: z.string(), muted: z.boolean().default(false) }))
    .min(1, '群聊至少要有一个成员'),
})
export type GroupInput = z.input<typeof groupInput>
