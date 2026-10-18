import type { Settings } from '../settings'
import { a1111Backend } from './a1111'
import { comfyBackend } from './comfy'
import { openaiBackend } from './openai'
import { openrouterBackend } from './openrouter'
import type { ImageBackend } from './types'

export const imageBackends: Readonly<Record<Settings['source'], ImageBackend>> = {
  openai: openaiBackend,
  comfy: comfyBackend,
  a1111: a1111Backend,
  openrouter: openrouterBackend,
}
export const getBackend = (settings: Pick<Settings, 'source'>): ImageBackend => imageBackends[settings.source]
export function backendDimensions(settings: Settings, width: number, height: number) {
  return getBackend(settings).dimensions?.(settings, width, height) ?? { width, height }
}
