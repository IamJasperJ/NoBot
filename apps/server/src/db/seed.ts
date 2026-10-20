import { parsePresetWithEnglishDefaults } from '@nobot/core'
import { t } from '../i18n'
import { migrateLegacyPrompts } from '../services/migrate-legacy-prompts'
import { seedPlayPresets } from '../services/playPresets.builtin'
import { SETTING_KEYS } from '../services/settings'
import { db, getSetting, newId, setSetting } from './client'
import { personas, promptPresets } from './schema'

export function seedUserDatabase() {
  seedPlayPresets()
  const now = Date.now()

  // 默认人设
  if (!getSetting<string>(SETTING_KEYS.defaultPersonaId)) {
    const existing = db.select({ id: personas.id }).from(personas).get()
    const id = existing?.id ?? newId()
    if (!existing) {
      db.insert(personas)
        .values({ id, name: t('旅人'), description: '', createdAt: now, updatedAt: now })
        .run()
      setSetting(SETTING_KEYS.builtinPersonaId, id)
    }
    setSetting(SETTING_KEYS.defaultPersonaId, id)
  }

  // 默认生成预设
  if (!getSetting<string>(SETTING_KEYS.defaultPromptPresetId)) {
    const existing = db.select({ id: promptPresets.id }).from(promptPresets).get()
    const id = existing?.id ?? newId()
    if (!existing) {
      db.insert(promptPresets)
        .values({ id, name: t('默认预设'), data: parsePresetWithEnglishDefaults({}), createdAt: now, updatedAt: now })
        .run()
      setSetting(SETTING_KEYS.builtinPromptPresetId, id)
    }
    setSetting(SETTING_KEYS.defaultPromptPresetId, id)
  }

  migrateLegacyPrompts()
}
