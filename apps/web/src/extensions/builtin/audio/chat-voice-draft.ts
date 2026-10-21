import type { ChatVoiceConfig, VoiceRef } from '@nobot/shared'

export interface ChatVoiceDraft {
  chatId: string
  config: ChatVoiceConfig | null
}
/** 只在同一会话内保留未填完的声音；跨会话绝不合并。 */
export function mergeChatVoiceDraft(previous: ChatVoiceDraft, chatId: string, saved: ChatVoiceConfig): ChatVoiceDraft {
  const prev = previous.chatId === chatId ? previous.config : null
  if (!prev) return { chatId, config: saved }
  const pending = (r: Record<string, VoiceRef>) => Object.fromEntries(Object.entries(r).filter(([, v]) => !v.voice))
  const keep = (v: VoiceRef | null | undefined, next: VoiceRef | null | undefined) =>
    v && !v.voice && next === undefined ? v : next
  return {
    chatId,
    config: {
      ...saved,
      narratorVoice: keep(prev.narratorVoice, saved.narratorVoice),
      userVoice: keep(prev.userVoice, saved.userVoice),
      characters: { ...pending(prev.characters), ...saved.characters },
      npcs: { ...pending(prev.npcs), ...saved.npcs },
    },
  }
}
