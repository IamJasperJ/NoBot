import type { ExtensionSettingField } from '@ai-parter/shared'
import type { Option } from '../options'
import type { Settings } from '../settings'

export interface BackendCapabilities {
  negativePrompt: boolean
  seed: boolean
  steps: boolean
  cfg: boolean
  sampler: boolean
  scheduler: boolean
  vae: boolean
  upscaler: boolean
  sizes: 'free' | { width: number; height: number }[]
}
export interface Discovery {
  models: Option[]
  samplers?: Option[]
  schedulers?: Option[]
  vaes?: Option[]
  upscalers?: Option[]
  adetailer?: boolean
}
export interface ImageJob {
  settings: Settings
  prompt: string
  width: number
  height: number
}
export interface ImageBackend {
  id: Settings['source']
  label: string
  settingsSchema: ExtensionSettingField[]
  capabilities: BackendCapabilities
  capabilitiesFor?(settings: Settings): BackendCapabilities
  promptStyle(settings: Settings): 'tags' | 'natural'
  model(settings: Settings): string
  resolveConnection?(settings: Settings): Settings
  validate(settings: Settings): void
  dimensions?(settings: Settings, width: number, height: number): { width: number; height: number }
  prepareAvatars?: boolean
  discover(settings: Settings): Promise<Discovery>
  test(settings: Settings): Promise<void>
  generate(job: ImageJob, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mime: string; seed?: number }>
}
export const diffusionCapabilities: BackendCapabilities = {
  negativePrompt: true,
  seed: true,
  steps: true,
  cfg: true,
  sampler: true,
  scheduler: true,
  vae: true,
  upscaler: true,
  sizes: 'free',
}
export const chatCapabilities: BackendCapabilities = {
  negativePrompt: false,
  seed: false,
  steps: false,
  cfg: false,
  sampler: false,
  scheduler: false,
  vae: false,
  upscaler: false,
  sizes: 'free',
}
/** 图片签名优先于默认格式，兼容上游返回 JPEG / WebP。 */
export function imageMime(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF') return 'image/webp'
  return 'image/png'
}
