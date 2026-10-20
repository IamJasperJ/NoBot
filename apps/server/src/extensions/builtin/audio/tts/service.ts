import { createHash } from 'node:crypto'
import { readdir, stat, unlink, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { castKey, parseStageMessage, toDisplayText } from '@nobot/core/stage'
import { type TtsLineResult, type TtsSpeaker, type VoiceRef, voiceRefSchema } from '@nobot/shared'
import { paths } from '../../../../env'
import { getCharacterRow } from '../../../../services/characters'
import { getChatRow, loadMessage } from '../../../../services/chats'
import { resolvePersona } from '../../../../services/context'
import { matchStageMember, stageMembers } from '../../../../services/stage'
import { openaiConnection, ttsEngines } from './engines'
import type { AudioSettings } from './settings'

export function cleanTtsText(text: string) {
  return toDisplayText(text, { knownNames: [], speaker: 'none' })
    .replace(/<[^>]*>/g, '')
    .replace(/[*_]/g, '')
    .trim()
}
export function poolVoice(name: string, pool: VoiceRef[]): VoiceRef | null {
  const hash = createHash('sha256').update(castKey(name)).digest().readUInt32BE(0)
  return pool.length ? pool[hash % pool.length]! : null
}
export function resolveVoice(
  chatId: string,
  speaker: TtsSpeaker,
  s: AudioSettings,
): VoiceRef | Extract<TtsLineResult, { kind: 'skip' }> {
  const skip = (reason: 'no-voice' | 'narration-off' | 'user-off') => ({ kind: 'skip' as const, reason })
  switch (speaker.kind) {
    case 'character': {
      const card = getCharacterRow(speaker.characterId)
      return (
        voiceRefSchema.safeParse(card.extensions.nobot_tts).data ??
        poolVoice(card.name, s.npcVoices) ??
        skip('no-voice')
      )
    }
    case 'user':
      return !s.readUser ? skip('user-off') : (s.userVoice ?? skip('no-voice'))
    case 'narrator':
      return !s.readNarration ? skip('narration-off') : (s.narratorVoice ?? skip('no-voice'))
    case 'npc': {
      const member = matchStageMember(chatId, speaker.name)
      if (member) return resolveVoice(chatId, { kind: 'character', characterId: member.id }, s)
      const persona = resolvePersona(getChatRow(chatId))
      if (castKey(persona.name) === castKey(speaker.name)) return resolveVoice(chatId, { kind: 'user' }, s)
      return poolVoice(speaker.name, s.npcVoices) ?? skip('no-voice')
    }
  }
}
export function expressionInstructions(expression?: string) {
  // 只允许固定英文语气，避免把任意角色文本当成服务指令发送。
  const tones: Record<string, string> = {
    happy: 'happy',
    joy: 'happy',
    sad: 'sad',
    sadness: 'sad',
    angry: 'angry',
    anger: 'angry',
    fear: 'fearful',
    surprise: 'surprised',
    neutral: 'neutral',
    love: 'warm',
    shy: 'shy',
  }
  const tone = tones[expression?.trim().toLowerCase() ?? '']
  return tone ? `Speak with a ${tone} tone.` : ''
}
export interface TtsSegment {
  speaker: TtsSpeaker
  text: string
  expression?: string
}
export function messageSegments(messageId: string): { chatId: string; segments: TtsSegment[] } {
  const message = loadMessage(messageId)
  const chatId = message.chatId
  if (message.role === 'user') return { chatId, segments: [{ speaker: { kind: 'user' }, text: message.content }] }
  const members = stageMembers(chatId)
  const beats =
    message.meta.stage?.beats ??
    parseStageMessage(message.content, {
      knownNames: members.map((m) => m.name),
      vars: {},
      inline: false,
      mvu: false,
    }).stage.beats
  const speaker: TtsSpeaker = message.speakerId
    ? { kind: 'character', characterId: message.speakerId }
    : members.length === 1
      ? { kind: 'character', characterId: members[0]!.id }
      : message.meta.name
        ? { kind: 'npc', name: message.meta.name }
        : { kind: 'narrator' }
  // narration 拍也可能夹有角色引语，与普通聊天共用同一套归属规则。
  const quotedSegments = (text: string): TtsSegment[] => {
    const segments: TtsSegment[] = []
    const pattern = /"([^"\n]+)"|“([^”]+)”|「([^」]+)」|『([^』]+)』/g
    let start = 0
    for (const match of text.matchAll(pattern)) {
      if (match.index > start) segments.push({ speaker: { kind: 'narrator' }, text: text.slice(start, match.index) })
      segments.push({ speaker, text: match.slice(1).find((value) => value !== undefined)! })
      start = match.index + match[0].length
    }
    if (start < text.length) segments.push({ speaker: { kind: 'narrator' }, text: text.slice(start) })
    return segments
  }
  if (!message.meta.stage && !beats.some((beat) => beat.kind === 'line'))
    return { chatId, segments: quotedSegments(message.content) }
  return {
    chatId,
    segments: beats.flatMap((b): TtsSegment[] =>
      b.kind === 'line'
        ? [{ speaker: { kind: 'npc', name: b.speaker }, text: b.text, expression: b.expression }]
        : b.kind === 'narration'
          ? quotedSegments(b.text)
          : [],
    ),
  }
}

export async function cacheEntries() {
  const names = (await readdir(paths.ttsCache)).filter((name) => /^[a-f0-9]{64}\.(mp3|wav)$/.test(name))
  return (
    await Promise.all(
      names.map(async (name) => {
        try {
          const info = await stat(join(paths.ttsCache, name))
          return { name, bytes: info.size, atime: info.atimeMs }
        } catch {
          return null
        }
      }),
    )
  ).filter((entry) => entry !== null)
}
let maintenance = Promise.resolve()
export async function clearTtsCache() {
  // 先等在途写入结束，清空之后不能被旧请求悄悄补回缓存。
  await Promise.allSettled([...pending.values()])
  maintenance = maintenance.then(async () => {
    for (const entry of await cacheEntries()) await unlink(join(paths.ttsCache, entry.name)).catch(() => {})
  })
  return maintenance
}
function trimCache(maxMb: number) {
  maintenance = maintenance
    .then(async () => {
      const entries = (await cacheEntries()).sort((a, b) => a.atime - b.atime)
      let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
      for (const entry of entries) {
        if (bytes <= maxMb * 1024 * 1024) break
        await unlink(join(paths.ttsCache, entry.name)).catch(() => {})
        bytes -= entry.bytes
      }
    })
    .catch(() => {})
}
export function cacheSettings(voice: VoiceRef, s: AudioSettings) {
  switch (voice.engine) {
    case 'openai': {
      const connection = openaiConnection(s)
      return { model: s.openaiModel, baseUrl: connection.baseUrl, headers: connection.headers }
    }
    case 'gptsovits':
      return { endpoint: s.gptsovitsEndpoint, preset: s.gptsovitsVoices.find((v) => v.id === voice.voice) }
    case 'elevenlabs':
      return { model: s.elevenlabsModel }
    case 'edge':
      return { volume: s.edgeVolume }
    default:
      return {}
  }
}
const pending = new Map<string, Promise<TtsLineResult>>()
export async function synthesizeVoice(
  voice: VoiceRef,
  text: string,
  s: AudioSettings,
  expression?: string,
): Promise<TtsLineResult> {
  text = cleanTtsText(text)
  if (!text) return { kind: 'skip', reason: 'empty' }
  if (voice.engine === 'browser') return { kind: 'browser', voice: voice.voice, speed: voice.speed, text }
  const style = voice.engine === 'openai' && s.expressionStyle ? expressionInstructions(expression) : ''
  const key = createHash('sha256')
    .update(JSON.stringify([voice, style, text, cacheSettings(voice, s)]))
    .digest('hex')
  const existing = pending.get(key)
  if (existing) return existing
  const task = (async (): Promise<TtsLineResult> => {
    for (const ext of ['mp3', 'wav']) {
      const name = `${key}.${ext}`
      if (await Bun.file(join(paths.ttsCache, name)).exists()) {
        await utimes(join(paths.ttsCache, name), new Date(), new Date()).catch(() => {})
        return { kind: 'audio', url: `/api/assets/tts-cache/${name}` }
      }
    }
    const result = await ttsEngines[voice.engine].synthesize({ ...voice, text, style }, s)
    const name = `${key}.${result.mime === 'audio/wav' ? 'wav' : 'mp3'}`
    await Bun.write(join(paths.ttsCache, name), result.bytes)
    // 写入完成后异步清理，不让目录扫描拖慢合成响应。
    trimCache(s.cacheMaxMb)
    return { kind: 'audio', url: `/api/assets/tts-cache/${name}` }
  })()
  pending.set(key, task)
  try {
    return await task
  } finally {
    pending.delete(key)
  }
}
