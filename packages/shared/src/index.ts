export * from './schemas/apiPreset'
export * from './schemas/character'
export * from './schemas/chat'
export * from './schemas/message'
export * from './schemas/persona'
export * from './schemas/prompt'
export * from './sse'

/** 统一的接口错误格式 */
export interface ApiError {
  error: { code: string; message: string }
}
