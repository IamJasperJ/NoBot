import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface AudioPrefs {
  muted: boolean
  master: number
  setMuted: (muted: boolean) => void
  setMaster: (master: number) => void
}
export const useAudioPrefs = create<AudioPrefs>()(
  persist(
    (set) => ({
      muted: false,
      master: 100,
      setMuted: (muted) => set({ muted }),
      setMaster: (master) => set({ master: Number.isFinite(master) ? Math.min(100, Math.max(0, master)) : 100 }),
    }),
    { name: 'nobot:audio', partialize: ({ muted, master }) => ({ muted, master }) },
  ),
)
