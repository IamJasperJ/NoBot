import { parsePresetWithEnglishDefaults } from '@ai-parter/core'
import { db, getSetting, initDatabase, newId, setSetting } from './db/client'
import { personas, promptPresets } from './db/schema'
import { loadLocalExtensions } from './extensions/registry'
import { seedPlayPresets } from './services/playPresets.builtin'
import { SETTING_KEYS } from './services/settings'

/**
 * 启动初始化：跑迁移，写入第一次启动需要的默认数据，加载第三方扩展。
 */
export async function bootstrap() {
  initDatabase()
  seedPlayPresets()
  const now = Date.now()

  // 默认人设
  if (!getSetting<string>(SETTING_KEYS.defaultPersonaId)) {
    const existing = db.select({ id: personas.id }).from(personas).get()
    const id = existing?.id ?? newId()
    if (!existing) {
      db.insert(personas).values({ id, name: '旅人', description: '', createdAt: now, updatedAt: now }).run()
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
        .values({ id, name: '默认预设', data: parsePresetWithEnglishDefaults({}), createdAt: now, updatedAt: now })
        .run()
      setSetting(SETTING_KEYS.builtinPromptPresetId, id)
    }
    setSetting(SETTING_KEYS.defaultPromptPresetId, id)
  }

  await loadLocalExtensions()
}
