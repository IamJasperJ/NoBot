import { create } from 'zustand'

/** 只阻止当前拍自动推进；手动推进和快进继续由 VN 播放器决定。 */
export const useVnVoiceStore = create<{ busyKey: string | null }>(() => ({ busyKey: null }))
