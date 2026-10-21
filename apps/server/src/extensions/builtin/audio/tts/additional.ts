import { join } from 'node:path'
import { guessVoiceGender } from '@nobot/core'
import type { TtsOption } from '@nobot/shared'

export { toneInstruction } from '@nobot/core'

import { paths } from '../../../../env'
import { HttpError } from '../../../../errors'
import { t } from '../../../../i18n'
import { listAudioTracks } from '../../../../services/audio-library'
import { deliveryCapabilities, engineInput } from './delivery'
import type { TtsEngine } from './engines'
import { cosyvoiceHeaders, cosyvoiceHeadersHash } from './settings'

const failed = () => new HttpError(502, 'TTS_FAILED', t('语音服务请求失败，请检查配置'))

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

export function additionalEngines(
  request: (url: string, init?: RequestInit, timeout?: number) => Promise<Response>,
  offline: () => boolean,
  mockAudio: Uint8Array,
): Pick<Record<string, TtsEngine>, 'minimax' | 'volcengine' | 'cosyvoice'> {
  const post = (url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal) =>
    request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    })
  const voicesCache = new Map<string, { expires: number; voices: TtsOption[] }>()
  const mock = { bytes: mockAudio, mime: 'audio/wav' }
  return {
    minimax: {
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
    },
    volcengine: {
      id: 'volcengine',
      deliveryCapabilities: (s, voice) => deliveryCapabilities('volcengine', s, voice),
      get label() {
        return t('火山引擎语音')
      },
      configured: (s) => !!s.volcengineAppId && !!s.volcengineAccessKey,
      voices: async (s) =>
        [
          'zh_female_xiaohe_uranus_bigtts',
          'zh_female_vv_uranus_bigtts',
          'saturn_zh_female_keainvsheng_tob',
          'saturn_zh_female_tiaopigongzhu_tob',
          'saturn_zh_female_cancan_tob',
          'saturn_zh_male_shuanglangshaonian_tob',
          'saturn_zh_male_tiancaitongzhuo_tob',
          'zh_male_taocheng_uranus_bigtts',
        ]
          .map((value) => ({ value, label: value, lang: 'zh', gender: guessVoiceGender('volcengine', value) }))
          .concat(
            s.volcengineCustomVoices
              .filter((v) => v.id)
              .map((v) => ({
                value: v.id,
                label: v.name || v.id,
                lang: '',
                gender: v.gender ?? guessVoiceGender('volcengine', v.id, v.name),
              })),
          ),
      synthesize: async (input, s, signal) => {
        const rendered = engineInput('volcengine', input, s)
        const params = rendered.params
        input = rendered
        signal?.throwIfAborted()
        if (offline()) return mock
        const response = await post(
          s.volcengineEndpoint,
          {
            req_params: {
              text: input.text,
              speaker: input.voice,
              audio_params: {
                format: 'mp3',
                sample_rate: 24000,
                speech_rate: Math.round(Math.max(-50, Math.min(100, (input.speed - 1) * 100))),
                ...(params.emotion ? { emotion: params.emotion, emotion_scale: params.emotionScale } : {}),
              },
              additions: JSON.stringify({
                ...(params.contextTexts ? { context_texts: params.contextTexts } : {}),
                mute_cut_threshold: '400',
                mute_cut_remain_ms: '1',
                explicit_language: 'crosslingual',
                enable_language_detector: true,
                disable_markdown_filter: true,
                cache_config: { use_cache: true, text_type: 1 },
              }),
            },
          },
          {
            'X-Api-App-Id': s.volcengineAppId,
            'X-Api-Access-Key': s.volcengineAccessKey,
            'X-Api-Resource-Id': s.volcengineResourceId,
          },
          signal,
        )
        const chunks: Uint8Array[] = []
        // 完整读取仍按行解析，兼容网络分块边界落在 JSON 或 UTF-8 字符中间，以及无末尾换行。
        for (const line of (await response.text()).split(/\r?\n/).filter((line) => line.trim())) {
          let item: { code: number; data?: string }
          try {
            item = JSON.parse(line)
          } catch {
            throw failed()
          }
          if (item.code !== 0 && item.code !== 20000000) throw failed()
          if (item.data) {
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) throw failed()
            chunks.push(Buffer.from(item.data, 'base64'))
          }
        }
        const bytes = Buffer.concat(chunks)
        if (!bytes.length) throw failed()
        return { bytes, mime: 'audio/mpeg' }
      },
    },
    cosyvoice: {
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
    },
  }
}
