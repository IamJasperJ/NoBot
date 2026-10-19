export * from './schemas/apiPreset'
export * from './schemas/background'
export * from './schemas/bookmark'
export * from './schemas/character'
export * from './schemas/chat'
export * from './schemas/group'
export * from './schemas/lorebook'
export * from './schemas/message'
export * from './schemas/persona'
export * from './schemas/preset'
export * from './schemas/profile'
export * from './schemas/prompt'
export * from './schemas/sprite'
export * from './schemas/stage'
export * from './schemas/summary'
export * from './schemas/system'
export * from './schemas/trash'
export * from './sse'

/** 统一的接口错误格式 */
export interface ApiError {
  error: { code: string; message: string }
}
export * from './providers'
export * from './schemas/audio'
export * from './schemas/quickReply'
export * from './schemas/translation'
export * from './schemas/trpg'
