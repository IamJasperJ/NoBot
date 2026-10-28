import type { ChannelBindingDTO, ChannelSettings, MessageDTO } from '@nobot/shared'
import { getSetting, setSetting } from '../../../db/client'
import { loadPath } from '../../../services/chats'
import type { ToolDefinition } from '../../../tools'
import type { ExtensionContext } from '../../types'
import { effectiveSettings } from '../audio/tts/chat-voice'
import { ttsEngines } from '../audio/tts/engines'
import { resolveVoiceSync } from '../audio/tts/service'
import { audioSettings } from '../audio/tts/settings'
import type { ChannelService } from './service'
import { listBindings } from './store'
import { nextVoicePreference, voiceIntent } from './voice-rules'

export const voicePreferenceKey = (id: string) => `channels:voice-preference:${id}`
export function updateVoicePreference(binding: ChannelBindingDTO, text: string, settings: ChannelSettings) {
  const key = voicePreferenceKey(binding.id)
  const previous = getSetting<ChannelBindingDTO['voicePreference']>(key)
  const next = nextVoicePreference(previous, text, settings, Date.now())
  if (next !== previous) setSetting(key, next)
}
/** 同步声音解析复用音频扩展的覆盖与声音池，不额外请求模型。 */
export function speakerTtsAvailable(chatId: string, speakerId?: string) {
  if (!speakerId || getSetting<Record<string, boolean>>('extensionsEnabled')?.audio !== true) return false
  const storage = {
    get: <T>(key: string) => getSetting<T>(`extdata:audio:${key}`),
    set: (key: string, value: unknown) => setSetting(`extdata:audio:${key}`, value),
    delete: () => {},
  }
  const settings = effectiveSettings(chatId, audioSettings.parse(getSetting('ext:audio') ?? {}), storage)
  if (!settings.ttsEnabled) return false
  const voice = resolveVoiceSync(chatId, { kind: 'character', characterId: speakerId }, settings)
  return !('kind' in voice) && voice.engine !== 'browser' && ttsEngines[voice.engine].configured(settings)
}
type Budget = { at: number; messageId: string }[]
const budgetKey = (id: string) => `channels:voice-budget:${id}`
export function voiceBudgetAvailable(id: string, max: number, now = Date.now(), messageId?: string) {
  const recent = (getSetting<Budget>(budgetKey(id)) ?? []).filter((entry) => entry.at > now - 3600000)
  return max === 0 || recent.some((entry) => entry.messageId === messageId) || recent.length < max
}
export function reserveVoice(id: string, max: number, messageId: string, now = Date.now()) {
  if (!voiceBudgetAvailable(id, max, now, messageId)) return false
  const recent = (getSetting<Budget>(budgetKey(id)) ?? []).filter((entry) => entry.at > now - 3600000)
  if (!recent.some((entry) => entry.messageId === messageId))
    setSetting(budgetKey(id), [...recent, { at: now, messageId }])
  return true
}
export function voiceTools(ctx: ExtensionContext, service: ChannelService): ToolDefinition[] {
  if (!ctx.chatId || !speakerTtsAvailable(ctx.chatId, ctx.speakerId)) return []
  const bindings = listBindings().filter(
    (binding) =>
      binding.chatId === ctx.chatId &&
      binding.state === 'active' &&
      service.runtime.accounts.has(binding.accountId) &&
      service.settings(binding).values.voice === 'decide' &&
      !binding.voicePreference?.suppressed &&
      voiceBudgetAvailable(binding.id, service.settings(binding).values.voiceDecideHourlyMax),
  )
  if (!bindings.length) return []
  const settings = service.settings(bindings[0]!).values
  const bias = bindings[0]!.voicePreference?.bias ?? settings.voiceDecideBias
  const wording = {
    low: 'Use voice sparingly, only when strongly appropriate.',
    medium: 'Use voice when it naturally fits.',
    high: 'Readily choose voice for warm or expressive moments.',
  }[bias]
  return [
    {
      name: 'send_voice',
      description: `Choose voice delivery for your current reply. Use when the user asks for a voice message or to hear you, for singing, lullabies, whispering, greetings like good night, or when voice clearly fits; otherwise do not use it. ${wording} This only marks delivery; keep writing the reply text normally. Write in the same language as the conversation.`,
      parameters: {
        type: 'object',
        properties: { style: { type: 'string', enum: ['only', 'with-text'] } },
        additionalProperties: false,
      },
      run(args) {
        if (args.style !== undefined && args.style !== 'only' && args.style !== 'with-text')
          return { content: 'Invalid voice style. Continue writing normally.' }
        const requestedStyle = args.style
        return {
          content: 'Voice delivery selected for your current reply. Keep writing the reply text normally.',
          meta: {
            channelVoice: {
              bindingIds: bindings.map((binding) => binding.id),
              style: requestedStyle ?? settings.voiceDecideStyle,
              bindingStyles: Object.fromEntries(
                bindings.map((binding) => [
                  binding.id,
                  requestedStyle ?? service.settings(binding).values.voiceDecideStyle,
                ]),
              ),
            },
          },
        }
      },
    },
  ]
}
/** 沿当前角色的工具链查找意图；遇到该角色已完成的上一条正文就停止。 */
export function replyVoiceStyle(binding: ChannelBindingDTO, message: MessageDTO, settings: ChannelSettings) {
  if (!['decide', 'button'].includes(settings.voice) || message.role !== 'assistant' || message.meta.toolCalls?.length)
    return undefined
  const path = loadPath(message.parentId)
  const user = [...path].reverse().find((entry) => entry.role === 'user')
  const explicit = user && voiceIntent(user.content) === 'request'
  if (settings.voice === 'decide' && binding.voicePreference?.suppressed) return undefined
  if (explicit) return settings.voice === 'button' ? 'with-text' : settings.voiceDecideStyle
  if (settings.voice !== 'decide') return undefined
  for (const entry of [...path].reverse()) {
    if (entry.role === 'user') break
    if (entry.speakerId !== message.speakerId) continue
    if (entry.meta.channelVoice?.bindingIds.includes(binding.id))
      return entry.meta.channelVoice.bindingStyles?.[binding.id] ?? entry.meta.channelVoice.style
    if (entry.role === 'assistant' && !entry.meta.toolCalls?.length) break
  }
  return undefined
}
export type VoiceDeliverySettings = ChannelSettings & { voiceDecisionSpeaker?: string }

export function voiceDeliverySettings(
  binding: ChannelBindingDTO,
  message: MessageDTO,
  settings: ChannelSettings,
  log: (code: string) => void,
): VoiceDeliverySettings {
  if (!['decide', 'button'].includes(settings.voice)) return settings
  const current = {
    ...binding,
    voicePreference: getSetting<ChannelBindingDTO['voicePreference']>(voicePreferenceKey(binding.id)),
  }
  const style = replyVoiceStyle(current, message, settings)
  if (!style || !speakerTtsAvailable(binding.chatId, message.speakerId ?? undefined)) return settings
  if (!reserveVoice(binding.id, settings.voiceDecideHourlyMax, message.id)) {
    log('media.voice.capped')
    return settings
  }
  return {
    ...settings,
    voice: style === 'only' ? ('only' as const) : ('auto' as const),
    voiceDecisionSpeaker: message.speakerId ?? undefined,
  }
}
