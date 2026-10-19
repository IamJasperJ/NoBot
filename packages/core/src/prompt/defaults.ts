import {
  DEFAULT_MAIN_PROMPT,
  type PresetData,
  presetDataSchema,
  type UtilityPrompts,
  utilityPromptsSchema,
} from '@nobot/shared'

/** 默认提示词以 shared 契约为准（已是英文），这里只是给 core / server 用的别名 */
export const DEFAULT_MAIN_PROMPT_EN = DEFAULT_MAIN_PROMPT
export const DEFAULT_UTILITY_PROMPTS_EN: UtilityPrompts = utilityPromptsSchema.parse({})

/** 只补缺失的默认值，保留已保存及导入的用户文字。 */
export function parsePresetWithEnglishDefaults(input: unknown): PresetData {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const defaults = presetDataSchema.parse({})
  for (const prompt of defaults.prompts) if (prompt.id === 'main') prompt.content = DEFAULT_MAIN_PROMPT_EN
  return presetDataSchema.parse({
    ...source,
    prompts: 'prompts' in source && source.prompts !== undefined ? source.prompts : defaults.prompts,
    utility: {
      ...DEFAULT_UTILITY_PROMPTS_EN,
      ...('utility' in source && source.utility && typeof source.utility === 'object' ? source.utility : {}),
    },
  })
}
