import { create } from 'zustand'

/**
 * 界面状态。
 * - view：左侧导航当前所在的页面
 * - 聊天页的选择（角色 / 群组 / 会话）记在 localStorage 里，刷新后还能回到原处
 * - focusId：从别的页面跳过来时要打开的对象（比如从聊天页点「编辑角色」）
 */
export type View = 'chat' | 'characters' | 'lorebooks' | 'presets' | 'connections' | 'personas' | 'extensions' | 'logs'

interface Selection {
  /** 侧栏展开的角色 */
  characterId: string | null
  /** 侧栏展开的群组 */
  groupId: string | null
  chatId: string | null
}

interface UiState extends Selection {
  view: View
  focusId: string | null
  previewOpen: boolean
  chatSettingsOpen: boolean
  sidebarOpen: boolean
  /** 切换页面；focusId 指定要打开的对象 */
  openView: (view: View, focusId?: string | null) => void
  selectCharacter: (id: string | null) => void
  selectGroup: (id: string | null) => void
  /** 打开某个会话（同时切到聊天页） */
  openChat: (owner: { characterId?: string | null; groupId?: string | null }, chatId: string | null) => void
  setPreviewOpen: (open: boolean) => void
  setChatSettingsOpen: (open: boolean) => void
  setSidebarOpen: (open: boolean) => void
}

const STORAGE_KEY = 'ai-parter:selection'

// localStorage 在隐私模式等情况下可能不可用，读写都要包 try/catch
function load(): Selection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { characterId: null, groupId: null, chatId: null, ...JSON.parse(raw) }
  } catch {
    // 忽略
  }
  return { characterId: null, groupId: null, chatId: null }
}

function save(s: Selection) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // 忽略
  }
}

export const useUi = create<UiState>((set, get) => ({
  ...load(),
  view: 'chat',
  focusId: null,
  previewOpen: false,
  chatSettingsOpen: false,
  sidebarOpen: false,
  openView: (view, focusId = null) => set({ view, focusId, sidebarOpen: false }),
  selectCharacter: (id) => {
    const next = { characterId: id, groupId: null, chatId: get().chatId }
    save(next)
    set(next)
  },
  selectGroup: (id) => {
    const next = { characterId: null, groupId: id, chatId: get().chatId }
    save(next)
    set(next)
  },
  openChat: (owner, chatId) => {
    const next = { characterId: owner.characterId ?? null, groupId: owner.groupId ?? null, chatId }
    save(next)
    set({ ...next, view: 'chat', sidebarOpen: false })
  },
  setPreviewOpen: (previewOpen) => set({ previewOpen }),
  setChatSettingsOpen: (chatSettingsOpen) => set({ chatSettingsOpen }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
}))
