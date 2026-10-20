import { z } from 'zod'

/** 音频库条目的种类，环境音以后再加。 */
export const AUDIO_KINDS = ['bgm', 'sfx', 'ref'] as const
export type AudioKind = (typeof AUDIO_KINDS)[number]

export interface AudioTrackDTO {
  id: string
  /** 模型按名字匹配，规则和背景相同。 */
  name: string
  /** 自动选择 BGM 时也作为候选说明提供给模型。 */
  description: string
  kind: AudioKind
  mime: string
  size: number
  durationMs: number | null
  url: string
  createdAt: number
}

export const updateAudioTrackInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(200).optional(),
  kind: z.enum(AUDIO_KINDS).optional(),
})
export const importAudioUrlInput = z.object({
  url: z.url(),
  name: z.string().trim().min(1).max(80).optional(),
  kind: z.enum(AUDIO_KINDS).default('bgm'),
})
export const batchDeleteAudioInput = z.object({ ids: z.array(z.string()).min(1).max(2000) })

export const TTS_ENGINES = [
  'browser',
  'openai',
  'gptsovits',
  'edge',
  'elevenlabs',
  'minimax',
  'volcengine',
  'cosyvoice',
] as const
export type TtsEngineId = (typeof TTS_ENGINES)[number]
export const voiceRefSchema = z.object({
  engine: z.enum(TTS_ENGINES),
  voice: z.string().min(1),
  /** 语速倍率。 */
  speed: z.number().min(0.5).max(2).default(1),
})
export type VoiceRef = z.infer<typeof voiceRefSchema>
export type TtsSpeaker =
  | { kind: 'character'; characterId: string }
  | { kind: 'user' }
  | { kind: 'narrator' }
  | { kind: 'npc'; name: string }
export type TtsLineResult =
  | { kind: 'browser'; voice: string; speed: number; text: string }
  | { kind: 'audio'; url: string }
  | { kind: 'skip'; reason: 'no-voice' | 'narration-off' | 'user-off' | 'empty' }

/** 会话级语音覆盖：字段缺省表示跟随全局设置。 */
export const chatVoiceConfigSchema = z.object({
  enabled: z.boolean().optional(),
  autoRead: z.boolean().optional(),
  vnVoice: z.boolean().optional(),
  readNarration: z.boolean().optional(),
  readUser: z.boolean().optional(),
  /** null 表示明确不朗读，缺省跟随全局。 */
  narratorVoice: voiceRefSchema.nullable().optional(),
  userVoice: voiceRefSchema.nullable().optional(),
  characters: z.record(z.string(), voiceRefSchema).default({}),
  npcs: z.record(z.string(), voiceRefSchema).default({}),
})
export type ChatVoiceConfig = z.infer<typeof chatVoiceConfigSchema>
export interface ChatVoiceDTO {
  config: ChatVoiceConfig
  members: { id: string; name: string; cardVoice: VoiceRef | null }[]
  npcs: { key: string; name: string; poolVoice: VoiceRef | null }[]
  global: {
    enabled: boolean
    autoRead: boolean
    vnVoice: boolean
    readNarration: boolean
    readUser: boolean
    narratorVoice: VoiceRef | null
    userVoice: VoiceRef | null
  }
  effective: { enabled: boolean; autoRead: boolean; vnVoice: boolean; vnWaitVoice: boolean; vnInterrupt: boolean }
}
