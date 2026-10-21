import { castKey } from '@nobot/core/stage'
import { type ChatVoiceConfig, type ChatVoiceDTO, chatVoiceConfigSchema, voiceRefSchema } from '@nobot/shared'
import { getCharacterRow } from '../../../../services/characters'
import { getChatRow, loadPath } from '../../../../services/chats'
import { resolvePersona } from '../../../../services/context'
import { computeStage, matchStageMember, stageMembers } from '../../../../services/stage'
import { readTemporaryActors } from '../../../../services/temporary-actors'
import type { ExtensionStorage } from '../../../types'
import { poolVoice } from './service'
import type { AudioSettings } from './settings'

export const chatVoiceKey = (chatId: string) => `tts-chat:${chatId}`
export type EffectiveAudioSettings = AudioSettings & { chatVoice?: ChatVoiceConfig }

export function readChatVoice(storage: ExtensionStorage, chatId: string): ChatVoiceConfig {
  getChatRow(chatId)
  const stored = storage.get(chatVoiceKey(chatId))
  // 草稿里的空声音不构成覆盖，不能让一个未填完的条目丢掉其余设置。
  const draft = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : stored
  if (draft && typeof draft === 'object') {
    const record = draft as Record<string, unknown>
    const unfinished = (value: unknown) =>
      value !== null && typeof value === 'object' && 'voice' in value && value.voice === ''
    for (const key of ['narratorVoice', 'userVoice']) if (unfinished(record[key])) delete record[key]
    for (const key of ['characters', 'npcs']) {
      const voices = record[key]
      if (voices && typeof voices === 'object' && !Array.isArray(voices))
        record[key] = Object.fromEntries(Object.entries(voices).filter(([, value]) => !unfinished(value)))
    }
  }
  return chatVoiceConfigSchema.safeParse(draft).data ?? chatVoiceConfigSchema.parse({})
}

export function effectiveSettings(
  chatId: string,
  global: AudioSettings,
  storage: ExtensionStorage,
): EffectiveAudioSettings {
  const config = readChatVoice(storage, chatId)
  const settings = { ...global, chatVoice: config }
  settings.deliveryMode = config.deliveryMode ?? global.deliveryMode
  settings.ttsEnabled = config.enabled ?? global.ttsEnabled
  for (const key of ['autoRead', 'vnVoice', 'readNarration', 'readUser'] as const)
    settings[key] = config[key] ?? global[key]
  for (const key of ['narratorVoice', 'userVoice'] as const) if (config[key] !== undefined) settings[key] = config[key]
  return settings
}

export function chatVoiceDTO(storage: ExtensionStorage, chatId: string, global: AudioSettings): ChatVoiceDTO {
  const settings = effectiveSettings(chatId, global, storage)
  const config = settings.chatVoice!
  const chat = getChatRow(chatId)
  const persona = resolvePersona(chat)
  const candidates = new Map<string, string>()
  const add = (name: string) => {
    const key = castKey(name)
    if (key && !matchStageMember(chatId, name) && key !== castKey(persona.name) && !candidates.has(key))
      candidates.set(key, name)
  }
  for (const actor of computeStage(chatId, loadPath(chat.activeLeafId))?.cast ?? []) add(actor.name)
  for (const actor of Object.values(readTemporaryActors(chatId))) add(actor.name)
  for (const key of Object.keys(config.npcs)) add(key)
  return {
    config,
    members: stageMembers(chatId).map(({ id, name }) => ({
      id,
      name,
      fallbackVoice: poolVoice(name, settings.npcVoices) ?? settings.narratorVoice,
      cardVoice: voiceRefSchema.safeParse(getCharacterRow(id).extensions.nobot_tts).data ?? null,
    })),
    npcs: [...candidates].map(([key, name]) => ({
      key,
      name,
      poolVoice: poolVoice(key, global.npcVoices),
      fallbackVoice: poolVoice(key, settings.npcVoices) ?? settings.narratorVoice,
    })),
    global: {
      enabled: global.ttsEnabled,
      deliveryMode: global.deliveryMode,
      autoRead: global.autoRead,
      vnVoice: global.vnVoice,
      readNarration: global.readNarration,
      readUser: global.readUser,
      narratorVoice: global.narratorVoice,
      userVoice: global.userVoice,
    },
    effective: {
      enabled: settings.ttsEnabled,
      autoRead: settings.autoRead,
      vnVoice: settings.vnVoice,
      vnWaitVoice: global.vnWaitVoice,
      vnInterrupt: global.vnInterrupt,
    },
  }
}
