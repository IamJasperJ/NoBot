import { deliveryFromExpression, parseCues, renderDelivery } from '@nobot/core'
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
              cues: ['laugh', 'chuckle', 'sigh', 'gasp', 'breath', 'sob', 'cough', 'clear-throat', 'exhale'],
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
          cues: ['laugh', 'chuckle', 'sigh', 'gasp', 'sob', 'pant', 'groan', 'yawn', 'clear-throat'],
          volume: true,
          format: 'fish-s2',
        })
      else if (s.fishModel === 's1')
        Object.assign(caps, {
          emotion: 'tags-fixed',
          cues: ['laugh', 'chuckle', 'sigh', 'gasp', 'sob', 'pant', 'groan', 'yawn'],
          volume: true,
          format: 'fish-s1',
        })
      break
    case 'minimax':
      Object.assign(caps, {
        emotion: 'enum',
        format: 'minimax',
        volume: /^speech-2\.6/.test(s.minimaxModel),
        cues: /^speech-2\.8/.test(s.minimaxModel) ? CUES.filter((cue) => cue !== 'sob' && cue !== 'yawn') : [],
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
      if (s.cosyvoiceApi === 'official' && !voice) caps.perVoice = true
      const instruct =
        s.cosyvoiceApi === 'gateway' || s.cosyvoiceVoices.find((v) => v.id === voice)?.mode === 'instruct'
      // tokenizer 的声音 token 与是否转发 instructions 无关，所有官方模式及网关都可消费。
      Object.assign(caps, { cues: ['laugh', 'breath', 'cough', 'sigh', 'gasp'], format: 'cosyvoice' })
      if (instruct)
        Object.assign(caps, {
          emotion: 'instruction',
          intensity: true,
          direction: true,
          // quick_breath 是急促吸气，映射 gasp 而不把持续喘息 pant 混为同一事件。
          cues: ['laugh', 'breath', 'cough', 'sigh', 'gasp'],
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
    parseCues(input.text),
  )
  if (
    input.style &&
    deliveryCapabilities(id, s, input.voice).emotion === 'instruction' &&
    !rendered.params.instructions
  )
    rendered.params.instructions = input.style
  return { ...input, ...rendered }
}
