import type { ActivateFn } from '../types'
import imageGen from './imageGen'
import summary from './summary'

/** 内置扩展随应用打包，共用前端扩展的注册与清理流程。 */
export const BUILTIN_CLIENTS: Record<string, ActivateFn> = { 'image-gen': imageGen, summary }
