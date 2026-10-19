import {
  type AppSettings,
  appSettingsSchema,
  type Language,
  type WorldInfoSettings,
  worldInfoSettingsSchema,
} from '@nobot/shared'
import { getSetting, setSetting } from '../db/client'

/**
 * settings 表里的键集中在这里，避免到处写字符串。
 */
export const SETTING_KEYS = {
  defaultPlayPresetId: 'defaultPlayPresetId',
  playPresetsSeeded: 'playPresetsSeeded',
  legacyPromptsMigrated: 'legacyPromptsMigrated',
  defaultProfileId: 'defaultProfileId',
  defaultApiPresetId: 'defaultApiPresetId',
  defaultPromptPresetId: 'defaultPromptPresetId',
  builtinPromptPresetId: 'builtinPromptPresetId',
  defaultPersonaId: 'defaultPersonaId',
  builtinPersonaId: 'builtinPersonaId',
  worldInfo: 'worldInfo',
  backgrounds: 'backgrounds',
  /** 扩展的启用状态：{ [扩展 id]: boolean } */
  extensionsEnabled: 'extensionsEnabled',
  /** 单个扩展的设置：ext:<扩展 id> */
  extensionSettings: (id: string) => `ext:${id}`,
  /** 应用级设置（界面语言等），见 AppSettings */
  app: 'app',
} as const

const DEFAULT_APP_SETTINGS: AppSettings = { language: 'zh' }

export function getAppSettings(): AppSettings {
  let stored: object | undefined
  try {
    stored = getSetting<object>(SETTING_KEYS.app)
  } catch (error) {
    // 启动迁移完成前也可能需要显示文件校验错误，此时使用默认语言。
    if (!(error instanceof Error) || !error.message.includes('no such table: settings')) throw error
  }
  const parsed = appSettingsSchema.safeParse({ ...DEFAULT_APP_SETTINGS, ...stored })
  return parsed.success ? parsed.data : DEFAULT_APP_SETTINGS
}

export function setAppSettings(value: AppSettings): AppSettings {
  setSetting(SETTING_KEYS.app, value)
  return value
}

/** 当前界面语言：后端给用户看的文字、没有对话上下文时模型的输出语言都按它来 */
export const getLanguage = (): Language => getAppSettings().language

export function getWorldInfoSettings(): WorldInfoSettings {
  return worldInfoSettingsSchema.parse(getSetting(SETTING_KEYS.worldInfo) ?? {})
}

export function setWorldInfoSettings(value: unknown): WorldInfoSettings {
  const parsed = worldInfoSettingsSchema.parse(value)
  setSetting(SETTING_KEYS.worldInfo, parsed)
  return parsed
}
