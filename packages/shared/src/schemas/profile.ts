import { z } from 'zod'
import type { ApiPresetDTO } from './apiPreset'
import type { PresetData } from './preset'

export const regexScriptSchema = z.object({
  name: z.string(),
  find: z.string(),
  replace: z.string(),
  input: z.boolean(),
  output: z.boolean(),
  prompt: z.boolean(),
  enabled: z.boolean(),
})
export type RegexScript = z.infer<typeof regexScriptSchema>

/** 配置组的图片生成覆盖：null 完全跟随扩展；空字段仅继承对应设置。 */
export const profileImageSchema = z.object({
  source: z.enum(['openai', 'comfy', 'a1111', 'openrouter']),
  /** OpenAI / OpenRouter 复用的连接；null 跟随扩展。 */
  connectionId: z.string().nullable().default(null),
  /** ComfyUI / A1111 服务地址；空串跟随扩展。 */
  url: z.string().trim().default(''),
  /** 图片模型或 checkpoint；空串跟随扩展。 */
  model: z.string().trim().default(''),
  /** null 跟随扩展，空串选择内置默认工作流。 */
  comfyWorkflow: z.string().nullable().default(null),
  style: z.string().default(''),
})
export type ProfileImage = z.infer<typeof profileImageSchema>

export const profileInput = z.object({
  name: z.string().trim().min(1),
  apiPresetId: z.string().nullable().default(null),
  promptPresetId: z.string().nullable().default(null),
  model: z.string().trim().default(''),
  // null 沿用全局规则；空数组明确禁用所有规则。
  regexScripts: z.array(regexScriptSchema).nullable().default(null),
  image: profileImageSchema.nullable().default(null),
  promptConnectionId: z.string().nullable().default(null),
})
export type ProfileInput = z.input<typeof profileInput>
export interface ProfileDTO extends z.output<typeof profileInput> {
  id: string
  isDefault: boolean
  createdAt: number
  updatedAt: number
}
export interface ResolvedProfileDTO {
  profile: ProfileDTO | null
  connection: ApiPresetDTO | null
  model: string
  preset: PresetData
  regex: RegexScript[] | null
  image: ProfileImage | null
  promptConnectionId: string | null
  source: 'chat' | 'character' | 'global' | 'legacy'
  summary: { baseUrl: string; model: string; presetName: string; source: ResolvedProfileDTO['source'] }
}
