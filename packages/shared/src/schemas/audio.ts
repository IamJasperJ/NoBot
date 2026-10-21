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
  'fish',
  'gptsovits',
  'edge',
  'elevenlabs',
  'minimax',
  'volcengine',
  'cosyvoice',
] as const
export type TtsEngineId = (typeof TTS_ENGINES)[number]
export const GENDERS = ['male', 'female', 'neutral'] as const
export type Gender = (typeof GENDERS)[number]
export type CharacterGender = 'male' | 'female' | 'other'
export interface TtsOption {
  value: string
  label: string
  lang?: string
  gender?: Gender
}
export const voiceRefSchema = z.object({
  engine: z.enum(TTS_ENGINES),
  gender: z.enum(GENDERS).optional(),
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
  | { kind: 'browser'; voice: string; speed: number; text: string; adjustments?: DeliveryProsody }
  | { kind: 'audio'; url: string }
  | { kind: 'skip'; reason: 'no-voice' | 'narration-off' | 'user-off' | 'empty' }

export const deliveryModeSchema = z.enum(['off', 'basic', 'rich'])

/** 会话级语音覆盖：字段缺省表示跟随全局设置。 */
export const chatVoiceConfigSchema = z.object({
  genders: z.record(z.string(), z.enum(['male', 'female', 'other'])).optional(),
  enabled: z.boolean().optional(),
  deliveryMode: deliveryModeSchema.optional(),
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
export interface ChatVoiceGender {
  gender: CharacterGender | null
  genderSource: 'chat' | 'card' | 'inferred' | null
}
export interface ChatVoiceDTO {
  config: ChatVoiceConfig
  members: (ChatVoiceGender & {
    id: string
    name: string
    cardVoice: VoiceRef | null
    fallbackVoice: VoiceRef | null
  })[]
  npcs: (ChatVoiceGender & { key: string; name: string; poolVoice: VoiceRef | null; fallbackVoice: VoiceRef | null })[]
  global: {
    enabled: boolean
    autoRead: boolean
    vnVoice: boolean
    readNarration: boolean
    readUser: boolean
    deliveryMode: z.infer<typeof deliveryModeSchema>
    narratorVoice: VoiceRef | null
    userVoice: VoiceRef | null
  }
  effective: { enabled: boolean; autoRead: boolean; vnVoice: boolean; vnWaitVoice: boolean; vnInterrupt: boolean }
}

/** Fish Audio 声音目录的归一化条目。 */
export interface FishVoiceItem {
  id: string
  title: string
  description: string
  author: string
  languages: string[]
  tags: string[]
  coverUrl: string | null
  sampleUrl: string | null
  liked: boolean
  marked: boolean
}
export interface FishVoiceSearchResult {
  items: FishVoiceItem[]
  total: number
  hasMore: boolean
}

export const TONES = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'neutral'] as const
export type Tone = (typeof TONES)[number]
export const CUES = ['laugh', 'chuckle', 'sigh', 'gasp', 'breath', 'sob', 'cough', 'clear-throat'] as const
export type Cue = (typeof CUES)[number]
export const spokenCuesSchema = z.array(z.object({ at: z.number().int().min(0), cue: z.enum(CUES) }))
export const deliverySchema = z.object({
  tone: z.enum(TONES),
  intensity: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  volume: z.enum(['whisper', 'normal', 'shout']).default('normal'),
  direction: z.string().max(120).default(''),
})
export type Delivery = z.infer<typeof deliverySchema>
/** 逐句标注只覆盖演绎方式，情绪仍由立绘表情决定。 */
export const lineDeliverySchema = z.object({
  volume: deliverySchema.shape.volume.removeDefault().optional(),
  direction: deliverySchema.shape.direction.removeDefault().optional(),
  intensity: deliverySchema.shape.intensity.removeDefault().optional(),
})
export type LineDelivery = z.infer<typeof lineDeliverySchema>
/** 插入点使用 JavaScript 字符串偏移，插在该位置之前。 */
export interface SpokenLine {
  text: string
  cues: { at: number; cue: Cue }[]
}
export type DeliveryFormat =
  | 'openai'
  | 'eleven-tags'
  | 'eleven-settings'
  | 'fish-s2'
  | 'fish-s1'
  | 'minimax'
  | 'volcengine'
  | 'cosyvoice'
  | 'gptsovits'
  | 'prosody'
  | 'none'
export interface DeliveryCapabilities {
  emotion: 'none' | 'enum' | 'instruction' | 'tags-free' | 'tags-fixed' | 'ref-audio' | 'prosody'
  intensity: boolean
  direction: boolean
  cues: Cue[]
  volume: boolean
  /** 同类能力的供应商语法不同，渲染时按此字段选择翻译表。 */
  format?: DeliveryFormat
}
export interface DeliveryProsody {
  rate: number
  pitch: number
  volume: number
}
export interface EngineDeliveryParams {
  instructions?: string
  emotion?: string
  emotionScale?: number
  contextTexts?: string[]
  voiceSettings?: { style: number; stability: number }
  tone?: Tone
  prosody?: DeliveryProsody
}

/** 角色卡 extensions.nobot_tts_style 的演绎说明。 */
export const characterDeliveryStyleSchema = z.string().max(200)
export type CharacterDeliveryStyle = z.infer<typeof characterDeliveryStyleSchema>
