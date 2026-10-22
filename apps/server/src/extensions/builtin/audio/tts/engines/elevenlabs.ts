import { guessVoiceGender } from '@nobot/core'
import { deliveryCapabilities, engineInput } from '../delivery'
import type { EngineHttp } from './http'
import type { TtsEngine } from './index'

export function createElevenlabsEngine({ request, synth, offline }: EngineHttp): TtsEngine {
  return {
    id: 'elevenlabs',
    deliveryCapabilities: (s, voice) => deliveryCapabilities('elevenlabs', s, voice),
    label: 'ElevenLabs',
    configured: (s) => !!s.elevenlabsApiKey,
    voices: async (s, signal) => {
      if (offline()) return [{ value: 'mock', label: 'Mock' }]
      const result = await request('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': s.elevenlabsApiKey },
        signal,
      })
      const data = (await result.json()) as {
        voices: { voice_id: string; name: string; labels?: { gender?: string } }[]
      }
      return data.voices.map((v) => ({
        value: v.voice_id,
        label: v.name,
        gender: guessVoiceGender('elevenlabs', '', v.labels?.gender),
      }))
    },
    synthesize: (input, s, signal) => {
      const rendered = engineInput('elevenlabs', input, s)
      return synth(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(input.voice)}?output_format=mp3_44100_128`,
        {
          text: rendered.text,
          model_id: s.elevenlabsModel,
          voice_settings: { speed: input.speed, ...rendered.params.voiceSettings },
        },
        { 'xi-api-key': s.elevenlabsApiKey },
        signal,
      )
    },
  }
}
