import { guessVoiceGender } from '@nobot/core'
import { t } from '../../../../../i18n'
import { deliveryCapabilities, engineInput } from '../delivery'
import type { EngineHttp } from './http'
import { failed } from './http'
import type { TtsEngine } from './index'

export function createVolcengineEngine(
  { post, offline }: EngineHttp,
  mock: { bytes: Uint8Array; mime: string },
): TtsEngine {
  return {
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
  }
}
