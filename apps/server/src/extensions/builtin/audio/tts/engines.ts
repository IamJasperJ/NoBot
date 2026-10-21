import type { DeliveryCapabilities, TtsEngineId } from '@nobot/shared'
import { HttpError } from '../../../../errors'
import { t } from '../../../../i18n'
import { getApiPresetRow } from '../../../../services/connections'
import { additionalEngines } from './additional'
import { deliveryCapabilities, engineInput, type SynthesisInput } from './delivery'
import { EDGE_BASE, EDGE_TOKEN, EdgeHandshakeError, edgeHeaders, edgeSynthesize, type SocketFactory } from './edge'
import { createFishClient, fishClient } from './fish'
import type { AudioSettings } from './settings'

export interface TtsEngine {
  id: TtsEngineId
  label: string
  voices(settings: AudioSettings, signal?: AbortSignal): Promise<{ value: string; label: string; lang?: string }[]>
  synthesize(
    input: SynthesisInput,
    settings: AudioSettings,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mime: string }>
  deliveryCapabilities(settings: AudioSettings, voice?: string): DeliveryCapabilities
  configured(settings: AudioSettings): boolean
}
export function openaiConnection(settings: AudioSettings) {
  if (settings.openaiConnectionId) return getApiPresetRow(settings.openaiConnectionId)
  return { baseUrl: settings.openaiBaseUrl, apiKey: settings.openaiApiKey, headers: {} }
}
// 固定的静音 WAV 也用于离线合成；不用监听端口或连接真实语音服务。
export const mockAudio = new Uint8Array(
  Buffer.from('UklGRiYAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQIAAAAAAA==', 'base64'),
)
export function createTtsEngines(
  network: { fetch?: typeof fetch; socket?: SocketFactory; mock?: boolean } = {},
): Record<TtsEngineId, TtsEngine> {
  const fish = Object.keys(network).length ? createFishClient(network) : fishClient
  const offline = () => network.mock ?? process.env.TTS_FETCH_MOCK === '1'
  const request = async (url: string, init: RequestInit = {}) => {
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
    try {
      const result = await (network.fetch ?? fetch)(url, { ...init, signal })
      if (!result.ok) throw new Error()
      return result
    } catch {
      // 不透传上游响应或 URL，避免第三方把密钥回显在错误里。
      throw new HttpError(502, 'TTS_FAILED', t('语音服务请求失败，请检查配置'))
    }
  }
  const synth = async (
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
    mime = 'audio/mpeg',
  ) => {
    signal?.throwIfAborted()
    if (offline()) return { bytes: mockAudio, mime: 'audio/wav' }
    const response = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    })
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (!bytes.length) throw new HttpError(502, 'TTS_FAILED', t('语音服务返回了空音频'))
    return { bytes, mime }
  }
  return {
    ...additionalEngines(request, offline, mockAudio),
    browser: {
      id: 'browser',
      deliveryCapabilities: (s, voice) => deliveryCapabilities('browser', s, voice),
      get label() {
        return t('浏览器系统语音')
      },
      configured: () => true,
      voices: async () => [],
      synthesize: async () => {
        throw new HttpError(502, 'TTS_FAILED', t('浏览器语音由客户端合成'))
      },
    },
    openai: {
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
        ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map(
          (value) => ({ value, label: value }),
        ),
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
    },
    fish: {
      id: 'fish',
      deliveryCapabilities: (s, voice) => deliveryCapabilities('fish', s, voice),
      get label() {
        return t('Fish Audio 语音')
      },
      configured: (s) => !!s.fishApiKey.trim() && !!s.fishEndpoint && !!s.fishModel,
      voices: fish.voices,
      synthesize: (input, s, signal) => {
        const rendered = engineInput('fish', input, s)
        return synth(
          s.fishEndpoint,
          {
            text: rendered.text,
            reference_id: input.voice,
            prosody: { speed: input.speed },
            format: 'mp3',
          },
          { Authorization: `Bearer ${s.fishApiKey.trim()}`, model: s.fishModel },
          signal,
        )
      },
    },
    gptsovits: {
      id: 'gptsovits',
      deliveryCapabilities: (s, voice) => deliveryCapabilities('gptsovits', s, voice),
      label: 'GPT-SoVITS',
      configured: (s) => !!s.gptsovitsEndpoint && s.gptsovitsVoices.some((v) => !!v.refAudioPath),
      voices: async (s) => s.gptsovitsVoices.map((v) => ({ value: v.id, label: v.name, lang: v.textLang })),
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
    },
    edge: {
      id: 'edge',
      deliveryCapabilities: (s, voice) => deliveryCapabilities('edge', s, voice),
      get label() {
        return t('Edge 语音')
      },
      configured: () => true,
      voices: async (_s, signal) => {
        if (offline()) return [{ value: 'zh-CN-XiaoxiaoNeural', label: 'zh-CN Female', lang: 'zh-CN' }]
        try {
          const response = await request(`https://${EDGE_BASE}/voices/list?trustedclienttoken=${EDGE_TOKEN}`, {
            headers: edgeHeaders,
            signal,
          })
          const voices = (await response.json()) as { ShortName: string; Locale: string; Gender: string }[]
          return voices
            .filter((v) => /^(zh|en|ja)-/.test(v.Locale))
            .map((v) => ({ value: v.ShortName, label: `${v.ShortName} (${v.Locale}, ${v.Gender})`, lang: v.Locale }))
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
    },
    elevenlabs: {
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
        const data = (await result.json()) as { voices: { voice_id: string; name: string }[] }
        return data.voices.map((v) => ({ value: v.voice_id, label: v.name }))
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
    },
  }
}
export const ttsEngines = createTtsEngines()
