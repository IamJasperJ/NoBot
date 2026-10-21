import { createHash } from 'node:crypto'
import { readdir, stat, unlink, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { deliveryFromExpression, expressionTone, guessVoiceGender, parseCues, renderDelivery } from '@nobot/core'
import { castKey, speechSegments, toDisplayText } from '@nobot/core/stage'
import {
  type CharacterGender,
  characterDeliveryStyleSchema,
  type Delivery,
  type LineDelivery,
  type SpokenLine,
  type TtsLineResult,
  type TtsSpeaker,
  type VoiceRef,
  voiceRefSchema,
} from '@nobot/shared'
import { paths } from '../../../../env'
import { getCharacterRow } from '../../../../services/characters'
import { getChatRow, loadMessage } from '../../../../services/chats'
import { resolvePersona } from '../../../../services/context'
import { matchStageMember, stageMembers } from '../../../../services/stage'
import { currentUser } from '../../../../user-context'
import { toneInstruction } from './additional'
import type { EffectiveAudioSettings } from './chat-voice'
import { openaiConnection, ttsEngines } from './engines'
import { type GenderContext, inferGender, readGender, waitForGender } from './gender'
import type { AudioSettings } from './settings'
import { cosyvoiceHeadersHash } from './settings'

export function cleanTtsText(text: string) {
  const cues: string[] = []
  text = text.replace(/<(laugh|chuckle|sigh|gasp|breath|sob|cough|clear-throat)\s*\/>/gi, (tag) => {
    cues.push(tag)
    return `\uE000${cues.length - 1}\uE001`
  })
  return toDisplayText(text, { knownNames: [], speaker: 'none' })
    .replace(/<[^>]*>/g, '')
    .replace(/[*_]/g, '')
    .trim()
    .replace(/\uE000(\d+)\uE001/g, (_, index: string) => cues[Number(index)] ?? '')
}
export function poolVoice(name: string, pool: VoiceRef[], gender?: CharacterGender | null): VoiceRef | null {
  const wanted = gender === 'other' ? 'neutral' : gender
  const matched = wanted ? pool.filter((v) => (v.gender ?? guessVoiceGender(v.engine, v.voice)) === wanted) : []
  if (matched.length) pool = matched
  const hash = createHash('sha256').update(castKey(name)).digest().readUInt32BE(0)
  return pool.length ? pool[hash % pool.length]! : null
}
export function resolveVoiceSync(
  chatId: string,
  speaker: TtsSpeaker,
  s: EffectiveAudioSettings,
  ctx?: GenderContext,
): VoiceRef | Extract<TtsLineResult, { kind: 'skip' }> {
  const gender = (speaker: Extract<TtsSpeaker, { kind: 'character' | 'npc' }>) =>
    s.genderMatch && ctx ? readGender(ctx.storage, chatId, speaker, s.chatVoice, s.genderInference).gender : null
  const skip = (reason: 'no-voice' | 'narration-off' | 'user-off') => ({ kind: 'skip' as const, reason })
  const narrator = s.chatVoice?.narratorVoice === undefined ? s.narratorVoice : s.chatVoice.narratorVoice
  switch (speaker.kind) {
    case 'character': {
      const card = getCharacterRow(speaker.characterId)
      return (
        s.chatVoice?.characters[speaker.characterId] ??
        voiceRefSchema.safeParse(card.extensions.nobot_tts).data ??
        poolVoice(card.name, s.npcVoices, gender(speaker)) ??
        narrator ??
        skip('no-voice')
      )
    }
    case 'user':
      return !s.readUser ? skip('user-off') : (s.userVoice ?? skip('no-voice'))
    case 'narrator':
      return !s.readNarration ? skip('narration-off') : (s.narratorVoice ?? skip('no-voice'))
    case 'npc': {
      const member = matchStageMember(chatId, speaker.name)
      if (member) return resolveVoiceSync(chatId, { kind: 'character', characterId: member.id }, s, ctx)
      const persona = resolvePersona(getChatRow(chatId))
      if (castKey(persona.name) === castKey(speaker.name)) return resolveVoiceSync(chatId, { kind: 'user' }, s, ctx)
      return (
        s.chatVoice?.npcs[castKey(speaker.name)] ??
        poolVoice(speaker.name, s.npcVoices, gender(speaker)) ??
        narrator ??
        skip('no-voice')
      )
    }
  }
}
/** 只有需要声音池时才调用模型；显式声音和关闭性别匹配的旧行为直接返回。 */
export async function resolveVoice(
  chatId: string,
  speaker: TtsSpeaker,
  s: EffectiveAudioSettings,
  ctx?: GenderContext,
) {
  if (speaker.kind === 'npc') {
    const member = matchStageMember(chatId, speaker.name)
    if (member) speaker = { kind: 'character', characterId: member.id }
    else if (castKey(resolvePersona(getChatRow(chatId)).name) === castKey(speaker.name)) speaker = { kind: 'user' }
  }
  if (ctx && s.genderMatch && s.npcVoices.length && (speaker.kind === 'character' || speaker.kind === 'npc')) {
    const explicit =
      speaker.kind === 'character'
        ? (s.chatVoice?.characters[speaker.characterId] ??
          voiceRefSchema.safeParse(getCharacterRow(speaker.characterId).extensions.nobot_tts).data)
        : s.chatVoice?.npcs[castKey(speaker.name)]
    if (!explicit) {
      const gender = await waitForGender(inferGender(ctx, chatId, speaker, s.chatVoice, s.genderInference))
      if (gender) {
        const id = speaker.kind === 'character' ? speaker.characterId : castKey(speaker.name)
        s = {
          ...s,
          chatVoice: { characters: {}, npcs: {}, ...s.chatVoice, genders: { ...s.chatVoice?.genders, [id]: gender } },
        }
      }
    }
  }
  return resolveVoiceSync(chatId, speaker, s, ctx)
}
/** 暂不提供会话覆盖，统一入口为后续扩展保留会话参数。 */
export function characterDeliveryStyle(characterId: string, _chatId: string): string {
  const style = getCharacterRow(characterId).extensions.nobot_tts_style
  return (
    characterDeliveryStyleSchema.safeParse(typeof style === 'string' ? style.trim().slice(0, 200) : style).data ?? ''
  )
}
export function speakerDeliveryStyle(speaker: TtsSpeaker, chatId: string): string {
  const id =
    speaker.kind === 'character'
      ? speaker.characterId
      : speaker.kind === 'npc'
        ? matchStageMember(chatId, speaker.name)?.id
        : undefined
  return id ? characterDeliveryStyle(id, chatId) : ''
}
export function expressionInstructions(expression?: string) {
  return toneInstruction(expressionTone(expression))
}
export type { TtsSegment } from '@nobot/core/stage'
export function messageSegments(messageId: string) {
  const message = loadMessage(messageId)
  return { chatId: message.chatId, segments: speechSegments(message, stageMembers(message.chatId)) }
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
const maintenanceQueues = new Map<string, Promise<void>>()
function maintenanceQueue() {
  return maintenanceQueues.get(currentUser().handle) ?? Promise.resolve()
}
function setMaintenance(task: Promise<void>) {
  maintenanceQueues.set(currentUser().handle, task)
  return task
}
export async function clearTtsCache() {
  // 先等在途写入结束，清空之后不能被旧请求悄悄补回缓存。
  await Promise.allSettled(
    [...pending].filter(([key]) => key.startsWith(`${currentUser().handle}:`)).map(([, task]) => task),
  )
  const task = maintenanceQueue().then(async () => {
    for (const entry of await cacheEntries()) await unlink(join(paths.ttsCache, entry.name)).catch(() => {})
  })
  return setMaintenance(task)
}
function trimCache(maxMb: number) {
  const task = maintenanceQueue()
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
  setMaintenance(task)
}
export function cacheSettings(voice: VoiceRef, s: AudioSettings) {
  switch (voice.engine) {
    case 'openai': {
      const connection = openaiConnection(s)
      return { model: s.openaiModel, baseUrl: connection.baseUrl, headers: connection.headers }
    }
    case 'fish':
      return { endpoint: s.fishEndpoint, model: s.fishModel }
    case 'gptsovits':
      return { endpoint: s.gptsovitsEndpoint, preset: s.gptsovitsVoices.find((v) => v.id === voice.voice) }
    case 'elevenlabs':
      return { model: s.elevenlabsModel }
    case 'minimax':
      return { host: s.minimaxApiHost, model: s.minimaxModel }
    case 'volcengine':
      return { endpoint: s.volcengineEndpoint, resourceId: s.volcengineResourceId }
    case 'cosyvoice':
      if (s.cosyvoiceApi === 'gateway')
        return {
          api: s.cosyvoiceApi,
          endpoint: s.cosyvoiceEndpoint,
          headers: cosyvoiceHeadersHash(s.cosyvoiceHeaders),
          voice: voice.voice,
        }
      return {
        headers: cosyvoiceHeadersHash(s.cosyvoiceHeaders),
        endpoint: s.cosyvoiceEndpoint,
        sampleRate: s.cosyvoiceSampleRate,
        preset: s.cosyvoiceVoices.find((v) => v.id === voice.voice),
        ref: s.cosyvoiceVoices.find((v) => v.id === voice.voice)?.refTrackId,
      }
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
  delivery?: LineDelivery,
  cues?: SpokenLine['cues'],
  style = '',
  director?: Partial<Delivery>,
): Promise<TtsLineResult> {
  const parsed = parseCues(text)
  // 原文标记优先；只有无标记的调用才使用显式插入点，再统一清理文本以免偏移失效。
  if (!parsed.cues.length && cues?.length) {
    for (const { at, cue } of [...cues].sort((a, b) => a.at - b.at).reverse()) {
      if (at <= text.length) text = `${text.slice(0, at)}<${cue}/>${text.slice(at)}`
    }
  }
  const line = parseCues(cleanTtsText(text))
  if (!line.text.trim()) return { kind: 'skip', reason: 'empty' }
  const engine = ttsEngines[voice.engine]
  const rendered = renderDelivery(
    engine.deliveryCapabilities(s, voice.voice),
    s.deliveryMode === 'off'
      ? undefined
      : { ...deliveryFromExpression(expression), ...director, ...(s.deliveryMode === 'rich' ? delivery : {}) },
    line,
    s.deliveryMode === 'off' ? '' : style,
  )
  text = rendered.text
  const params = rendered.params
  if (voice.engine === 'browser')
    return { kind: 'browser', voice: voice.voice, speed: voice.speed, text, adjustments: params.prosody }
  const key = createHash('sha256')
    .update(JSON.stringify([voice, text, params, cacheSettings(voice, s)]))
    .digest('hex')
  const pendingKey = `${currentUser().handle}:${key}`
  const existing = pending.get(pendingKey)
  if (existing) return existing
  const task = (async (): Promise<TtsLineResult> => {
    for (const ext of ['mp3', 'wav']) {
      const name = `${key}.${ext}`
      if (await Bun.file(join(paths.ttsCache, name)).exists()) {
        await utimes(join(paths.ttsCache, name), new Date(), new Date()).catch(() => {})
        return { kind: 'audio', url: `/api/assets/tts-cache/${name}` }
      }
    }
    const result = await ttsEngines[voice.engine].synthesize({ ...voice, text, params }, s)
    const name = `${key}.${result.mime === 'audio/wav' ? 'wav' : 'mp3'}`
    await Bun.write(join(paths.ttsCache, name), result.bytes)
    // 写入完成后异步清理，不让目录扫描拖慢合成响应。
    trimCache(s.cacheMaxMb)
    return { kind: 'audio', url: `/api/assets/tts-cache/${name}` }
  })()
  pending.set(pendingKey, task)
  try {
    return await task
  } finally {
    pending.delete(pendingKey)
  }
}
