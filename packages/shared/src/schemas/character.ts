import { z } from 'zod'
import { promptRoleSchema } from './message'

/** 角色列表里展示的精简信息 */
export interface CharacterSummary {
  id: string
  name: string
  /** 256px 缩略图地址，没有头像时为 null */
  avatarUrl: string | null
  tags: string[]
  updatedAt: number
}

/** 角色卡里参与 Prompt 组装的字段，与酒馆 V2/V3 卡的 data 字段同名 */
export const characterFieldsSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(''),
  personality: z.string().default(''),
  scenario: z.string().default(''),
  first_mes: z.string().default(''),
  alternate_greetings: z.array(z.string()).default([]),
  mes_example: z.string().default(''),
  system_prompt: z.string().default(''),
  post_history_instructions: z.string().default(''),
  creator_notes: z.string().default(''),
  tags: z.array(z.string()).default([]),
  creator: z.string().default(''),
  character_version: z.string().default(''),
})
export type CharacterFields = z.infer<typeof characterFieldsSchema>

/** 本应用额外的角色设置（导出时写进角色卡的 extensions 字段，酒馆也认识） */
export const characterExtrasSchema = z.object({
  /** 群聊里没被点名时的发言积极度 0–1（酒馆的 talkativeness） */
  talkativeness: z.number().min(0).max(1).default(0.5),
  /** 角色备注（酒馆的 Character's Note / depth_prompt），按深度插入聊天记录 */
  characterNote: z.string().default(''),
  characterNoteDepth: z.number().int().min(0).default(4),
  characterNoteRole: promptRoleSchema.default('system'),
  /** 用这个角色新建会话时默认使用的人设，为空则用全局默认 */
  defaultPersonaId: z.string().nullable().default(null),
})
export type CharacterExtras = z.infer<typeof characterExtrasSchema>

export const characterInput = characterFieldsSchema.extend(characterExtrasSchema.shape).extend({
  /** 挂在这个角色上的世界书，第一本是导出时嵌入角色卡的「主世界书」 */
  lorebookIds: z.array(z.string()).default([]),
})
export type CharacterInput = z.input<typeof characterInput>

export const characterUpdateInput = characterInput.partial()
export type CharacterUpdateInput = z.infer<typeof characterUpdateInput>

/** 角色详情 */
export interface CharacterDTO extends CharacterFields, CharacterExtras {
  id: string
  avatarUrl: string | null
  lorebookIds: string[]
  createdAt: number
  updatedAt: number
}
