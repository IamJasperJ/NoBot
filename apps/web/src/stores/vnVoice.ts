import { create } from 'zustand'

interface VnVoiceState {
  busyKey: string | null
  unlocked: boolean
  voiceBlocked: boolean
  lastVoiceError: { message: string; at: number } | null
}

/** 语音状态供聊天和 VN 共用；busyKey 只阻止当前拍自动推进。 */
export const useVnVoiceStore = create<VnVoiceState>(() => ({
  busyKey: null,
  unlocked: false,
  voiceBlocked: false,
  lastVoiceError: null,
}))
