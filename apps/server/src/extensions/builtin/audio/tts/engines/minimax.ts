import { guessVoiceGender } from '@nobot/core'
import { HttpError } from '../../../../../errors'
import { t } from '../../../../../i18n'
import { deliveryCapabilities, engineInput } from '../delivery'
import type { EngineHttp } from './http'
import { failed } from './http'
import type { TtsEngine } from './index'

export function createMinimaxEngine(
  { post, offline }: EngineHttp,
  mock: { bytes: Uint8Array; mime: string },
): TtsEngine {
  return {
    id: 'minimax',
    deliveryCapabilities: (s, voice) => deliveryCapabilities('minimax', s, voice),
    label: 'MiniMax',
    configured: (s) => !!s.minimaxApiKey,
    voices: async (s) =>
      [
        'Chinese (Mandarin)_Unrestrained_Young_Man',
        'Chinese (Mandarin)_Warm_Bestie',
        'Chinese (Mandarin)_Gentle_Youth',
        'Chinese (Mandarin)_Sweet_Lady',
        'Chinese (Mandarin)_Soft_Girl',
        'Chinese (Mandarin)_Lyrical_Voice',
        'Chinese (Mandarin)_Male_Announcer',
        'Chinese (Mandarin)_Gentle_Senior',
        'English_Trustworthy_Man',
        'English_Graceful_Lady',
        'English_Aussie_Bloke',
        'English_Gentle-voiced_man',
        'English_Whispering_girl',
        'English_Diligent_Man',
      ]
        .map((value) => ({
          value,
          label: value,
          lang: value.startsWith('English') ? 'en' : 'zh',
          gender: guessVoiceGender('minimax', value),
        }))
        .concat(
          s.minimaxCustomVoices
            .filter((v) => v.id)
            .map((v) => ({
              value: v.id,
              label: v.name || v.id,
              lang: '',
              gender: v.gender ?? guessVoiceGender('minimax', v.id, v.name),
            })),
        ),
    synthesize: async (input, s, signal) => {
      const rendered = engineInput('minimax', input, s)
      const params = rendered.params
      input = rendered
      signal?.throwIfAborted()
      if (offline()) return mock
      const response = await post(
        `${s.minimaxApiHost.replace(/\/+$/, '')}/v1/t2a_v2`,
        {
          model: s.minimaxModel,
          text: input.text,
          stream: false,
          voice_setting: {
            voice_id: input.voice,
            speed: input.speed,
            vol: 1,
            pitch: 0,
            ...(params.emotion ? { emotion: params.emotion } : {}),
          },
          audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
        },
        { Authorization: `Bearer ${s.minimaxApiKey}` },
        signal,
      )
      const data = (await response.json()) as { data?: { audio?: string }; base_resp?: { status_code?: number } }
      if (data.base_resp?.status_code === 1004)
        throw new HttpError(502, 'TTS_AUTH_FAILED', t('语音服务鉴权失败，请检查密钥'))
      if (data.base_resp?.status_code !== 0 || !data.data?.audio || !/^(?:[\da-f]{2})+$/i.test(data.data.audio))
        throw failed()
      return { bytes: Buffer.from(data.data.audio, 'hex'), mime: 'audio/mpeg' }
    },
  }
}
