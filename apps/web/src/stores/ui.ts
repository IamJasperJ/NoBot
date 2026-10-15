import { create } from 'zustand'

/** 界面状态。当前选中的角色和会话记在 localStorage 里，刷新后还能回到原处 */
interface UiState {
  characterId: string | null
  chatId: string | null
  settingsOpen: boolean
  previewOpen: boolean
  sidebarOpen: boolean
  selectCharacter: (id: string | null) => void
  selectChat: (characterId: string, chatId: string | null) => void
  setSettingsOpen: (open: boolean) => void
  setPreviewOpen: (open: boolean) => void
  setSidebarOpen: (open: boolean) => void
}

const STORAGE_KEY = 'ai-parter:selection'

// localStorage 在隐私模式等情况下可能不可用，读写都要包 try/catch
function load(): { characterId: string | null; chatId: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // 忽略
  }
  return { characterId: null, chatId: null }
}

function save(characterId: string | null, chatId: string | null) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ characterId, chatId }))
  } catch {
    // 忽略
  }
}

export const useUi = create<UiState>((set) => ({
  ...load(),
  settingsOpen: false,
  previewOpen: false,
  sidebarOpen: false,
  selectCharacter: (id) =>
    set(() => {
      save(id, null)
      return { characterId: id, chatId: null }
    }),
  selectChat: (characterId, chatId) =>
    set(() => {
      save(characterId, chatId)
      return { characterId, chatId, sidebarOpen: false }
    }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setPreviewOpen: (previewOpen) => set({ previewOpen }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
}))
