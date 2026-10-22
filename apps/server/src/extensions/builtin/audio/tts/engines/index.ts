import type { DeliveryCapabilities, TtsEngineId, TtsOption } from '@nobot/shared'
import type { SynthesisInput } from '../delivery'
import type { AudioSettings } from '../settings'
import { createBrowserEngine } from './browser'
import { createCosyvoiceEngine } from './cosyvoice'
import { createEdgeEngine } from './edge'
import type { SocketFactory } from './edge/client'
import { createElevenlabsEngine } from './elevenlabs'
import { createFishClient, createFishEngine, fishClient } from './fish'
import { createGptsovitsEngine } from './gptsovits'
import { createEngineHttp } from './http'
import { createMinimaxEngine } from './minimax'
import { createOpenaiEngine } from './openai'
import { createVolcengineEngine } from './volcengine'

export { openaiConnection } from './openai'

export interface TtsEngine {
  id: TtsEngineId
  label: string
  voices(settings: AudioSettings, signal?: AbortSignal): Promise<TtsOption[]>
  synthesize(
    input: SynthesisInput,
    settings: AudioSettings,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mime: string }>
  deliveryCapabilities(settings: AudioSettings, voice?: string): DeliveryCapabilities
  configured(settings: AudioSettings): boolean
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
  const http = createEngineHttp(network, offline, mockAudio)
  const mock = { bytes: mockAudio, mime: 'audio/wav' }
  return {
    minimax: createMinimaxEngine(http, mock),
    volcengine: createVolcengineEngine(http, mock),
    cosyvoice: createCosyvoiceEngine(http, mock),
    browser: createBrowserEngine(),
    openai: createOpenaiEngine(http),
    fish: createFishEngine(http, fish),
    gptsovits: createGptsovitsEngine(http),
    edge: createEdgeEngine(http, mockAudio, network),
    elevenlabs: createElevenlabsEngine(http),
  }
}
export const ttsEngines = createTtsEngines()
