import { z } from 'zod'
import { promptRoleSchema } from './message'
import { characterSheetSchema } from './trpg'

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
  defaultBackgroundId: z.string().nullable().default(null),
  /** 跑团属性卡（VN5），队友 / 固定 NPC 用；null 表示没有 */
  sheet: characterSheetSchema.nullable().default(null),
})
export type CharacterExtras = z.infer<typeof characterExtrasSchema>

export const characterInput = characterFieldsSchema.extend(characterExtrasSchema.shape).extend({
  profileId: z.string().nullable().default(null),
  /** 挂在这个角色上的世界书，第一本是导出时嵌入角色卡的「主世界书」 */
  lorebookIds: z.array(z.string()).default([]),
  /**
   * 角色卡 data.extensions 里本应用不认识的字段，原样保留、导出时写回（酒馆和各种扩展把自己的数据放在这里）。
   * 扩展也可以往这里存角色级数据，比如图片生成扩展的 sd_character_prompt（和酒馆同名同格式，互相兼容）
   */
  extensions: z.record(z.string(), z.unknown()).default({}),
})
export type CharacterInput = z.input<typeof characterInput>

export const characterUpdateInput = characterInput
  .partial()
  .extend({ quickReplySetIds: z.array(z.string()).optional() })
export type CharacterUpdateInput = z.infer<typeof characterUpdateInput>

/** 角色详情 */
export interface CharacterDTO extends CharacterFields, CharacterExtras {
  quickReplySetIds?: string[]
  profileId: string | null
  id: string
  avatarUrl: string | null
  lorebookIds: string[]
  /** 见 characterInput.extensions */
  extensions: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

/** 导入角色卡前的预读结果：前端据此询问用户要不要导入卡里的世界书 */
export interface CharacterImportPreview {
  name: string
  spec: 'v1' | 'v2' | 'v3'
  hasAvatar: boolean
  /** 卡里内嵌的世界书，没有则为 null */
  lorebook: { name: string; entryCount: number } | null
}

/**
 * 卡里世界书的处理方式：
 * - link：导入成一本新世界书，并作为主世界书关联到这个角色
 * - import：导入成新世界书，但不关联
 * - skip：不导入（原始数据仍保留在角色卡里，导出时不会丢）
 */
export const characterImportLorebookSchema = z.enum(['link', 'import', 'skip'])
export type CharacterImportLorebook = z.infer<typeof characterImportLorebookSchema>
