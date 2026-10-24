import { create } from 'zustand'

export interface RoomTurnState {
  running?: boolean
  pendingCount?: number
  waitingUntil?: number | null
  cooldownUntil?: number
  error?: string
}
export const useRoomLive = create<{
  typing: Record<string, Record<string, number>>
  turns: Record<string, RoomTurnState>
  suggestions: Record<string, Record<string, string[]>>
  setTyping: (roomId: string, userId: string, expiresAt: number) => void
  clearRoom: (roomId: string) => void
}>((set) => ({
  typing: {},
  turns: {},
  suggestions: {},
  setTyping: (roomId, userId, expiresAt) => {
    set((s) => ({ typing: { ...s.typing, [roomId]: { ...s.typing[roomId], [userId]: expiresAt } } }))
    setTimeout(
      () =>
        set((s) => {
          const typing = { ...s.typing[roomId] }
          if ((typing[userId] ?? 0) > Date.now()) return s
          delete typing[userId]
          return { typing: { ...s.typing, [roomId]: typing } }
        }),
      Math.max(0, expiresAt - Date.now()),
    )
  },
  clearRoom: (roomId) =>
    set((s) => {
      const typing = { ...s.typing },
        turns = { ...s.turns },
        suggestions = { ...s.suggestions }
      delete typing[roomId]
      delete turns[roomId]
      delete suggestions[roomId]
      return { typing, turns, suggestions }
    }),
}))
