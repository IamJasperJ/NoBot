import { guessVoiceGender } from '@nobot/core'
import { t } from '../../../../../i18n'
import { getApiPresetRow } from '../../../../../services/connections'
import { deliveryCapabilities, engineInput } from '../delivery'
import type { AudioSettings } from '../settings'
import type { EngineHttp } from './http'
import type { TtsEngine } from './index'

export function openaiConnection(settings: AudioSettings) {
  if (settings.openaiConnectionId) return getApiPresetRow(settings.openaiConnectionId)
  return { baseUrl: settings.openaiBaseUrl, apiKey: settings.openaiApiKey, headers: {} }
}

export function createOpenaiEngine({ synth }: EngineHttp): TtsEngine {
  return {
    id: 'openai',
    deliveryCapabilities: (s, voice) => deliveryCapabilities('openai', s, voice),
    get label() {
      return t('OpenAI 兼容语音')
    },
    configured: (s) => {
      try {
        const c = openaiConnection(s)
        return !!c.baseUrl && !!c.apiKey
      } catch {
        return false
      }
    },
    voices: async () =>
      ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map((value) => ({
        value,
        label: value,
        gender: guessVoiceGender('openai', value),
      })),
    synthesize: (input, s, signal) => {
      const rendered = engineInput('openai', input, s)
      input = rendered
      const c = openaiConnection(s)
      return synth(
        `${c.baseUrl.replace(/\/+$/, '')}/audio/speech`,
        {
          model: s.openaiModel,
          input: input.text,
          voice: input.voice,
          speed: input.speed,
          response_format: 'mp3',
          ...(rendered.params.instructions ? { instructions: rendered.params.instructions } : {}),
        },
        { ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}), ...c.headers },
        signal,
      )
    },
  }
}
