import { guessVoiceGender } from '@nobot/core'
import { HttpError } from '../../../../../errors'
import { t } from '../../../../../i18n'
import { deliveryCapabilities, engineInput } from '../delivery'
import {
  EDGE_BASE,
  EDGE_TOKEN,
  EdgeHandshakeError,
  edgeHeaders,
  edgeSynthesize,
  type SocketFactory,
} from './edge/client'
import type { EngineHttp } from './http'
import type { TtsEngine } from './index'

export function createEdgeEngine(
  { request, offline }: EngineHttp,
  mockAudio: Uint8Array,
  network: { fetch?: typeof fetch; socket?: SocketFactory },
): TtsEngine {
  return {
    id: 'edge',
    deliveryCapabilities: (s, voice) => deliveryCapabilities('edge', s, voice),
    get label() {
      return t('Edge 语音')
    },
    configured: () => true,
    voices: async (_s, signal) => {
      if (offline()) return [{ value: 'zh-CN-XiaoxiaoNeural', label: 'zh-CN Female', lang: 'zh-CN', gender: 'female' }]
      try {
        const response = await request(`https://${EDGE_BASE}/voices/list?trustedclienttoken=${EDGE_TOKEN}`, {
          headers: edgeHeaders,
          signal,
        })
        const voices = (await response.json()) as { ShortName: string; Locale: string; Gender: string }[]
        return voices
          .filter((v) => /^(zh|en|ja)-/.test(v.Locale))
          .map((v) => ({
            value: v.ShortName,
            label: `${v.ShortName} (${v.Locale}, ${v.Gender})`,
            lang: v.Locale,
            gender: guessVoiceGender('edge', v.ShortName, v.Gender),
          }))
      } catch {
        throw new HttpError(502, 'TTS_FAILED', t('Edge 朗读失败，接口可能已变化'))
      }
    },
    synthesize: async (input, _s, signal) => {
      signal?.throwIfAborted()
      if (offline()) return { bytes: mockAudio, mime: 'audio/wav' }
      try {
        const rendered = engineInput('edge', input, _s)
        const prosody = rendered.params.prosody ?? { rate: 1, pitch: 1, volume: 1 }
        return await edgeSynthesize(
          {
            ...rendered,
            speed: input.speed * prosody.rate,
            pitch: (prosody.pitch - 1) * 100,
            volume: Math.max(-100, Math.min(100, ((1 + _s.edgeVolume / 100) * prosody.volume - 1) * 100)),
          },
          signal,
          network.socket,
          network.fetch,
        )
      } catch (error) {
        signal?.throwIfAborted()
        if (error instanceof EdgeHandshakeError) throw new HttpError(502, 'TTS_HANDSHAKE_FAILED', error.message)
        throw new HttpError(502, 'TTS_FAILED', t('Edge 朗读失败，接口可能已变化'))
      }
    },
  }
}
