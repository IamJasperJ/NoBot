import { HttpError } from '../../../../../errors'
import { t } from '../../../../../i18n'
import { deliveryCapabilities } from '../delivery'
import type { TtsEngine } from './index'

export function createBrowserEngine(): TtsEngine {
  return {
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
  }
}
