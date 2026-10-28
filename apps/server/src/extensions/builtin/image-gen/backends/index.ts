import type { Settings } from '../settings'
import { a1111Backend } from './a1111'
import { comfyBackend } from './comfy'
import { openaiBackend } from './openai'
import { openrouterBackend } from './openrouter'
import type { ImageBackend } from './types'

export const imageBackends: Readonly<Record<Settings['source'], ImageBackend>> = {
  // 后端与 discovery 互相引用；读取时再取绑定，避免单独导入后端时触发未初始化错误。
  get openai() {
    return openaiBackend
  },
  get comfy() {
    return comfyBackend
  },
  get a1111() {
    return a1111Backend
  },
  get openrouter() {
    return openrouterBackend
  },
}
export const getBackend = (settings: Pick<Settings, 'source'>): ImageBackend => imageBackends[settings.source]
export function backendDimensions(settings: Settings, width: number, height: number) {
  return getBackend(settings).dimensions?.(settings, width, height) ?? { width, height }
}
