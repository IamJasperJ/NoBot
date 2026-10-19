import { DEFAULT_MAIN_PROMPT, utilityPromptsSchema } from '@nobot/shared'
import { eq } from 'drizzle-orm'
import { db, getSetting, setSetting } from '../db/client'
import { playPresets, promptPresets, settings } from '../db/schema'
import { t } from '../i18n'
import {
  LEGACY_DIRECTIVE_TEMPLATES,
  LEGACY_EXTENSION_PROMPTS,
  LEGACY_MAIN_PROMPT,
  LEGACY_STATE_SCHEMAS,
  LEGACY_UTILITY_PROMPTS,
} from './legacy-zh-defaults'
import { insertLog } from './logs'
import { BUILTIN_PLAY_PRESETS } from './playPresets.builtin'
import { SETTING_KEYS } from './settings'

/** 仅替换逐字等于历史默认值的字段；标记、数据和日志一起提交，失败后可在下次启动重试。 */
export function migrateLegacyPrompts(): number {
  if (getSetting(SETTING_KEYS.legacyPromptsMigrated) === 1) return 0
  return db.transaction(() => {
    let count = 0
    const utility = utilityPromptsSchema.parse({})
    for (const row of db.select().from(promptPresets).all()) {
      const before = count
      for (const prompt of row.data.prompts) {
        if (prompt.id === 'main' && prompt.content === LEGACY_MAIN_PROMPT) {
          prompt.content = DEFAULT_MAIN_PROMPT
          count++
        }
      }
      for (const key of Object.keys(LEGACY_UTILITY_PROMPTS) as (keyof typeof LEGACY_UTILITY_PROMPTS)[]) {
        if (row.data.utility?.[key] === LEGACY_UTILITY_PROMPTS[key] && utility[key] !== LEGACY_UTILITY_PROMPTS[key]) {
          row.data.utility[key] = utility[key]
          count++
        }
      }
      if (count !== before) db.update(promptPresets).set({ data: row.data }).where(eq(promptPresets.id, row.id)).run()
    }
    for (const row of db.select().from(playPresets).all()) {
      const before = count
      if (Object.values(LEGACY_DIRECTIVE_TEMPLATES).some((template) => row.data.directives?.template === template)) {
        row.data.directives.template = ''
        count++
      }
      for (const key of Object.keys(LEGACY_STATE_SCHEMAS) as (keyof typeof LEGACY_STATE_SCHEMAS)[]) {
        if (LEGACY_STATE_SCHEMAS[key].some((schema) => row.data.state?.schema === schema)) {
          row.data.state.schema = BUILTIN_PLAY_PRESETS.find((def) => def.key === key)!.build().state.schema
          count++
          break
        }
      }
      if (count !== before) db.update(playPresets).set({ data: row.data }).where(eq(playPresets.id, row.id)).run()
    }
    for (const [id, defaults] of Object.entries(LEGACY_EXTENSION_PROMPTS)) {
      const key = SETTING_KEYS.extensionSettings(id)
      const stored = getSetting<unknown>(key)
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) continue
      const value: Record<string, unknown> = { ...stored }
      const before = count
      for (const [field, old] of Object.entries(defaults)) {
        if (value[field] === old) {
          delete value[field]
          count++
        }
      }
      if (count !== before) db.update(settings).set({ value }).where(eq(settings.key, key)).run()
    }
    insertLog({ kind: 'extension', status: 'ok', summary: t('已把 {n} 处旧的中文默认提示词换成英文', { n: count }) })
    setSetting(SETTING_KEYS.legacyPromptsMigrated, 1)
    return count
  })
}
