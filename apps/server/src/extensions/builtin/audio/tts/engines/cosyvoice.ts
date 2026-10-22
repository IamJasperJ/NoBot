import { join } from 'node:path'
import { guessVoiceGender } from '@nobot/core'
import type { TtsOption } from '@nobot/shared'
import { paths } from '../../../../../env'
import { HttpError } from '../../../../../errors'
import { t } from '../../../../../i18n'
import { listAudioTracks } from '../../../../../services/audio/audio-library'
import { deliveryCapabilities, engineInput } from '../delivery'
import { cosyvoiceHeaders, cosyvoiceHeadersHash } from '../settings'
import type { EngineHttp } from './http'
import { failed } from './http'
import type { TtsEngine } from './index'

/** 官方 FastAPI 输出单声道 int16 PCM，补标准 WAV 头后才能直接交给浏览器播放。 */
export function pcmWav(pcm: Uint8Array, sampleRate: number) {
  if (!pcm.length || pcm.length % 2) throw failed()
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

export function createCosyvoiceEngine(
  { request, offline }: EngineHttp,
  mock: { bytes: Uint8Array; mime: string },
): TtsEngine {
  const voicesCache = new Map<string, { expires: number; voices: TtsOption[] }>()
  return {
    id: 'cosyvoice',
    deliveryCapabilities: (s, voice) => deliveryCapabilities('cosyvoice', s, voice),
    label: 'CosyVoice',
    configured: (s) => !!s.cosyvoiceEndpoint && (s.cosyvoiceApi === 'gateway' || s.cosyvoiceVoices.length > 0),
    voices: async (s, signal) => {
      if (s.cosyvoiceApi !== 'gateway')
        return s.cosyvoiceVoices.map((v) => ({
          value: v.id,
          label: v.name,
          gender: v.gender ?? guessVoiceGender('cosyvoice', v.id, v.name),
        }))
      if (offline()) return [{ value: 'default', label: 'default' }]
      try {
        const endpoint = s.cosyvoiceEndpoint.replace(/\/+$/, '')
        const key = JSON.stringify([endpoint, cosyvoiceHeadersHash(s.cosyvoiceHeaders)])
        const cached = voicesCache.get(key)
        if (cached && cached.expires > Date.now()) return cached.voices
        const response = await request(
          `${endpoint}/voices`,
          { headers: cosyvoiceHeaders(s.cosyvoiceHeaders), signal },
          180000,
        )
        const data: unknown = await response.json()
        if (
          !data ||
          typeof data !== 'object' ||
          !('voices' in data) ||
          !Array.isArray(data.voices) ||
          !data.voices.every((name: unknown) => typeof name === 'string' && name.length > 0)
        )
          throw failed()
        const voices = (data.voices as string[]).map((name) => ({
          value: name,
          label: name,
          gender: guessVoiceGender('cosyvoice', name, name),
        }))
        voicesCache.set(key, { expires: Date.now() + 120000, voices })
        return voices
      } catch {
        throw failed()
      }
    },
    synthesize: async (input, s, signal) => {
      const rendered = engineInput('cosyvoice', input, s)
      const params = rendered.params
      input = rendered
      signal?.throwIfAborted()
      if (s.cosyvoiceApi === 'gateway') {
        if (offline()) return mock
        const headers = new Headers({ 'Content-Type': 'application/json' })
        for (const [key, value] of Object.entries(cosyvoiceHeaders(s.cosyvoiceHeaders))) headers.set(key, value)
        const response = await request(
          `${s.cosyvoiceEndpoint.replace(/\/+$/, '')}/v1/audio/speech`,
          {
            method: 'POST',
            headers,
            signal,
            body: JSON.stringify({
              input: input.text,
              model: 'cosyvoice3',
              voice: input.voice,
              speed: input.speed,
              response_format: 'wav',
              instructions: s.deliveryMode === 'off' ? '' : (params.instructions ?? ''),
            }),
          },
          180000,
        )
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (!bytes.length) throw failed()
        return { bytes, mime: 'audio/wav' }
      }
      const preset = s.cosyvoiceVoices.find((v) => v.id === input.voice)
      if (!preset) throw new HttpError(502, 'TTS_FAILED', t('参考声音预设不存在或不完整'))
      if (offline()) return mock
      const form = new FormData()
      form.set('tts_text', input.text)
      if (preset.mode === 'zero_shot') {
        const track = listAudioTracks('ref').find((v) => v.id === preset.refTrackId)
        if (!track) throw new HttpError(502, 'TTS_FAILED', t('参考声音预设不存在或不完整'))
        form.set('prompt_text', preset.promptText)
        form.set('prompt_wav', Bun.file(join(paths.audio, track.url.split('/').pop()!)), track.name)
      } else {
        form.set('spk_id', preset.spkId)
        if (preset.mode === 'instruct') form.set('instruct_text', params.instructions ?? '')
      }
      const response = await request(`${s.cosyvoiceEndpoint.replace(/\/+$/, '')}/inference_${preset.mode}`, {
        method: 'POST',
        body: form,
        headers: cosyvoiceHeaders(s.cosyvoiceHeaders),
        signal,
      })
      return { bytes: pcmWav(new Uint8Array(await response.arrayBuffer()), s.cosyvoiceSampleRate), mime: 'audio/wav' }
    },
  }
}
