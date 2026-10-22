import { guessVoiceGender } from '@nobot/core'
import { HttpError } from '../../../../../errors'
import { t } from '../../../../../i18n'
import { deliveryCapabilities, engineInput } from '../delivery'
import type { EngineHttp } from './http'
import type { TtsEngine } from './index'

export function createGptsovitsEngine({ synth }: EngineHttp): TtsEngine {
  return {
    id: 'gptsovits',
    deliveryCapabilities: (s, voice) => deliveryCapabilities('gptsovits', s, voice),
    label: 'GPT-SoVITS',
    configured: (s) => !!s.gptsovitsEndpoint && s.gptsovitsVoices.some((v) => !!v.refAudioPath),
    voices: async (s) =>
      s.gptsovitsVoices.map((v) => ({
        value: v.id,
        label: v.name,
        lang: v.textLang,
        gender: v.gender ?? guessVoiceGender('gptsovits', v.id, v.name),
      })),
    synthesize: (input, s, signal) => {
      const rendered = engineInput('gptsovits', input, s)
      input = rendered
      const preset = s.gptsovitsVoices.find((v) => v.id === input.voice)
      if (!preset?.refAudioPath) throw new HttpError(502, 'TTS_FAILED', t('参考声音预设不存在或不完整'))
      const ref = rendered.params.tone ? preset.emotionRefs.find((v) => v.tone === rendered.params.tone) : undefined
      return synth(
        `${s.gptsovitsEndpoint.replace(/\/+$/, '')}/tts`,
        {
          text: input.text,
          text_lang: preset.textLang,
          ref_audio_path: ref?.refAudioPath || preset.refAudioPath,
          prompt_text: ref?.promptText ?? preset.promptText,
          prompt_lang: preset.promptLang,
          text_split_method: 'cut5',
          batch_size: 1,
          media_type: 'wav',
          streaming_mode: false,
          speed_factor: input.speed,
        },
        {},
        signal,
        'audio/wav',
      )
    },
  }
}
