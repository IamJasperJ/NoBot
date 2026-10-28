import type { ChannelBindingDTO, ChannelSettings } from '@nobot/shared'

// 规则只描述用户意图；否定优先，避免把「不要发语音」识别成单次请求。
export const voicePatterns = {
  suppress:
    /(?:别(?:发|用)?语音|不要(?:发|用)?语音|不用语音|无需语音|不想听语音|\bno voice\b|\b(?:do not|don't) (?:send|use) (?:a )?voice\b)/iu,
  allow: /(?:可以发语音|恢复语音|允许语音|\b(?:allow|enable) voice\b|\bvoice is ok\b)/iu,
  more: /(?:多发语音|以后都发语音|\bmore voice\b)/iu,
  request: /(?:发语音|用语音|语音说|说给我听|念给我听|\bvoice message\b|\bsay it out loud\b)/iu,
} as const
export function voiceIntent(text: string) {
  if (voicePatterns.suppress.test(text)) return 'suppress'
  if (voicePatterns.allow.test(text)) return 'allow'
  if (voicePatterns.more.test(text)) return 'more'
  return voicePatterns.request.test(text) ? 'request' : undefined
}
export function nextVoicePreference(
  previous: ChannelBindingDTO['voicePreference'],
  text: string,
  settings: ChannelSettings,
  now: number,
): ChannelBindingDTO['voicePreference'] {
  if (settings.voice !== 'decide') return previous
  const intent = voiceIntent(text)
  if (intent === 'suppress') return { ...previous, suppressed: true, updatedAt: now }
  if (intent === 'allow') return { ...previous, suppressed: false, updatedAt: now }
  if (intent === 'more') {
    const levels = ['low', 'medium', 'high'] as const
    const bias = levels[Math.min(2, levels.indexOf(previous?.bias ?? settings.voiceDecideBias) + 1)]!
    return { ...previous, bias, updatedAt: now }
  }
  return previous
}
