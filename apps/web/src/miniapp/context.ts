import type { BackgroundDTO, CharacterDTO, PlayPresetDTO, RoomDTO } from '@nobot/shared'
import { create } from 'zustand'

export const isMiniApp = () => globalThis.location?.pathname === '/tg'
export interface MiniAppContext {
  status: 'loading' | 'ready' | 'error'
  scope: { kind: 'room'; roomId: string } | { kind: 'chat'; chatId: string } | null
  chatId: string | null
  roomId: string | null
  error: string | null
  backgrounds?: BackgroundDTO[]
  room?: RoomDTO
  preset?: PlayPresetDTO
  character?: CharacterDTO | null
}
export const useMiniAppContext = create<MiniAppContext>(() => ({
  status: 'loading',
  scope: null,
  chatId: null,
  roomId: null,
  error: null,
}))
export const useMiniAppSession = useMiniAppContext
