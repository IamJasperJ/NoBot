import { deliveryFromExpression, renderDelivery } from '@nobot/core'
import {
  CUES,
  type Delivery,
  type DeliveryCapabilities,
  type EngineDeliveryParams,
  type Tone,
  type TtsEngineId,
} from '@nobot/shared'
import type { AudioSettings } from './settings'

export interface SynthesisInput {
  text: string
  voice: string
  speed: number
  params?: EngineDeliveryParams
  delivery?: Delivery
  /** 兼容原有引擎调用，服务层统一使用 params。 */
  tone?: Tone
  style?: string
}

export function deliveryCapabilities(id: TtsEngineId, s: AudioSettings, voice?: string): DeliveryCapabilities {
  const caps: DeliveryCapabilities = {
    emotion: 'none',
    intensity: false,
    direction: false,
    cues: [],
    volume: false,
    format: 'none',
  }
  switch (id) {
    case 'openai':
      if (/gpt-4o-mini-tts/.test(s.openaiModel))
        Object.assign(caps, {
          emotion: 'instruction',
          intensity: true,
          direction: true,
          cues: [...CUES],
          volume: true,
          format: 'openai',
        })
      break
    case 'elevenlabs':
      Object.assign(
        caps,
        /v[34]/i.test(s.elevenlabsModel)
          ? {
              emotion: 'tags-free',
              intensity: true,
              direction: true,
              cues: [...CUES],
              volume: true,
              format: 'eleven-tags',
            }
          : { emotion: 'enum', intensity: true, format: 'eleven-settings' },
      )
      break
    case 'fish':
      if (s.fishModel.startsWith('s2'))
        Object.assign(caps, {
          emotion: 'tags-free',
          intensity: true,
          direction: true,
          cues: ['laugh', 'chuckle', 'sigh', 'gasp', 'sob'],
          volume: true,
          format: 'fish-s2',
        })
      else if (s.fishModel === 's1')
        Object.assign(caps, { emotion: 'tags-fixed', cues: ['laugh', 'sigh'], volume: true, format: 'fish-s1' })
      break
    case 'minimax':
      Object.assign(caps, {
        emotion: 'enum',
        format: 'minimax',
        volume: /^speech-2\.6/.test(s.minimaxModel),
        cues: /^speech-2\.8/.test(s.minimaxModel) ? [...CUES] : [],
      })
      break
    case 'volcengine': {
      const instruction = /2\.0/.test(s.volcengineResourceId) && !/standard/.test(s.volcengineResourceId)
      Object.assign(caps, {
        emotion: 'enum',
        intensity: true,
        direction: instruction,
        volume: instruction,
        format: 'volcengine',
      })
      break
    }
    case 'cosyvoice': {
      const instruct = voice
        ? s.cosyvoiceVoices.find((v) => v.id === voice)?.mode === 'instruct'
        : s.cosyvoiceVoices.some((v) => v.mode === 'instruct')
      if (instruct)
        Object.assign(caps, {
          emotion: 'instruction',
          intensity: true,
          direction: true,
          cues: ['laugh', 'breath'],
          volume: true,
          format: 'cosyvoice',
        })
      break
    }
    case 'gptsovits':
      Object.assign(caps, { emotion: 'ref-audio', format: 'gptsovits' })
      break
    case 'edge':
    case 'browser':
      Object.assign(caps, { emotion: 'prosody', intensity: true, volume: true, format: 'prosody' })
      break
  }
  return caps
}

/** 旧调用入口也走统一翻译，避免各引擎自行维护情绪映射。 */
export function engineInput(id: TtsEngineId, input: SynthesisInput, s: AudioSettings) {
  if (input.params) return { ...input, params: input.params }
  const rendered = renderDelivery(
    deliveryCapabilities(id, s, input.voice),
    input.delivery ?? (input.tone ? { ...deliveryFromExpression(), tone: input.tone } : undefined),
    { text: input.text, cues: [] },
  )
  if (
    input.style &&
    deliveryCapabilities(id, s, input.voice).emotion === 'instruction' &&
    !rendered.params.instructions
  )
    rendered.params.instructions = input.style
  return { ...input, ...rendered }
}
