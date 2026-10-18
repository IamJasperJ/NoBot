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

export const profileInput = z.object({
  name: z.string().trim().min(1),
  apiPresetId: z.string().nullable().default(null),
  promptPresetId: z.string().nullable().default(null),
  model: z.string().trim().default(''),
  // null 沿用全局规则；空数组明确禁用所有规则。
  regexScripts: z.array(regexScriptSchema).nullable().default(null),
  imageConnectionId: z.string().nullable().default(null),
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
  imageConnectionId: string | null
  promptConnectionId: string | null
  source: 'chat' | 'character' | 'global' | 'legacy'
  summary: { baseUrl: string; model: string; presetName: string; source: ResolvedProfileDTO['source'] }
}
