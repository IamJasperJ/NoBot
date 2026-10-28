import { speechSegments, type TtsSegment, toDisplayText } from '@nobot/core/stage'
import type { ChannelSettings, MessageDTO } from '@nobot/shared'
import { cleanProtocolText } from './visible-text'

/** 优先在句末拆分；超长单句按 Unicode 字符截断，保证每段都在平台上限内。 */
export function splitVoiceText(text: string, limit: number): string[] {
  const chars = Array.from(text.trim())
  const parts: string[] = []
  while (chars.length) {
    while (chars.length && /\s/u.test(chars[0]!)) chars.shift()
    let take = Math.min(limit, chars.length)
    if (chars.length > limit) {
      for (let i = take - 1; i >= 0; i--) {
        if (/[。！？.!?；;\n]/u.test(chars[i]!)) {
          take = i + 1
          break
        }
      }
    }
    const part = chars.splice(0, take).join('').trim()
    if (part) parts.push(part)
  }
  return parts
}

export function channelSpeechPlan(
  message: MessageDTO,
  members: { id: string; name: string }[],
  settings: ChannelSettings,
) {
  const only = settings.voice === 'only'
  const narration: string[] = []
  const segments: TtsSegment[] = []
  for (const source of speechSegments({ ...message, content: cleanProtocolText(message.content) }, members)) {
    const text = toDisplayText(cleanProtocolText(source.text), {
      knownNames: members.map((m) => m.name),
      speaker: 'none',
    })
      .replace(/<[^>]*>/g, '')
      .trim()
    if (!text) continue
    const speaker = source.speaker
    const member = speaker.kind === 'npc' ? members.find((m) => m.name === speaker.name) : undefined
    const segment = {
      ...source,
      text,
      speaker: member ? { kind: 'character' as const, characterId: member.id } : source.speaker,
    }
    if (only && segment.speaker.kind === 'narrator' && settings.voiceNarration !== 'speak') {
      if (settings.voiceNarration === 'text') narration.push(text)
    } else segments.push(segment)
  }
  return {
    segments: segments.flatMap((segment) =>
      splitVoiceText(segment.text, only ? settings.voiceMaxChars : 4500).map((text) => ({ ...segment, text })),
    ),
    narration: narration.join(' ').replace(/\s+/g, ' '),
  }
}
