import { z } from 'zod'

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
})
export type CharacterFields = z.infer<typeof characterFieldsSchema>

export const characterUpdateInput = characterFieldsSchema.partial()
export type CharacterUpdateInput = z.infer<typeof characterUpdateInput>

/** 角色详情 */
export interface CharacterDTO extends CharacterFields {
  id: string
  avatarUrl: string | null
  createdAt: number
  updatedAt: number
}
