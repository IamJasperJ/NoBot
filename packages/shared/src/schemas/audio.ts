import { z } from 'zod'

/** 音频库条目的种类，环境音以后再加。 */
export const AUDIO_KINDS = ['bgm', 'sfx'] as const
export type AudioKind = (typeof AUDIO_KINDS)[number]

export interface AudioTrackDTO {
  id: string
  /** 模型按名字匹配，规则和背景相同。 */
  name: string
  /** 只给用户看，不进入提示词。 */
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
