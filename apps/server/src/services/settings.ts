import { type WorldInfoSettings, worldInfoSettingsSchema } from '@ai-parter/shared'
import { getSetting, setSetting } from '../db/client'

/**
 * settings 表里的键集中在这里，避免到处写字符串。
 */
export const SETTING_KEYS = {
  defaultPlayPresetId: 'defaultPlayPresetId',
  playPresetsSeeded: 'playPresetsSeeded',
  defaultApiPresetId: 'defaultApiPresetId',
  defaultPromptPresetId: 'defaultPromptPresetId',
  defaultPersonaId: 'defaultPersonaId',
  worldInfo: 'worldInfo',
  backgrounds: 'backgrounds',
  /** 扩展的启用状态：{ [扩展 id]: boolean } */
  extensionsEnabled: 'extensionsEnabled',
  /** 单个扩展的设置：ext:<扩展 id> */
  extensionSettings: (id: string) => `ext:${id}`,
} as const

export function getWorldInfoSettings(): WorldInfoSettings {
  return worldInfoSettingsSchema.parse(getSetting(SETTING_KEYS.worldInfo) ?? {})
}

export function setWorldInfoSettings(value: unknown): WorldInfoSettings {
  const parsed = worldInfoSettingsSchema.parse(value)
  setSetting(SETTING_KEYS.worldInfo, parsed)
  return parsed
}
