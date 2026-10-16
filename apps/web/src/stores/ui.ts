import { create } from 'zustand'

/**
 * 界面状态。
 * - view：左侧导航当前所在的页面
 * - 聊天页的选择（角色 / 群组 / 会话）记在 localStorage 里，刷新后还能回到原处
 * - focusId：从别的页面跳过来时要打开的对象（比如从聊天页点「编辑角色」）
 */
export type View =
  | 'chat'
  | 'characters'
  | 'lorebooks'
  | 'presets'
  | 'connections'
  | 'backgrounds'
  | 'personas'
  | 'extensions'
  | 'logs'
  | 'settings'

interface Selection {
  /** 侧栏展开的角色 */
  characterId: string | null
  /** 侧栏展开的群组 */
  groupId: string | null
  chatId: string | null
  /** 侧栏面板是否打开（点左侧导航的同一项可以开关） */
  panelOpen: boolean
}

interface UiState extends Selection {
  /** 侧栏面板当前显示哪一项（聊天主区始终是对话，不随它切换） */
  view: View
  focusId: string | null
  /** 扩展详情当前页面；null 表示「设置」标签，focusId 保存扩展 ID */
  extensionPageId: string | null
  previewOpen: boolean
  chatSettingsOpen: boolean
  /** 手机上的抽屉（导航 + 侧栏面板）是否打开 */
  sidebarOpen: boolean
  /** 打开某个面板；focusId 指定要打开的对象（比如从消息菜单「查看请求」跳到日志） */
  openView: (view: View | `ext:${string}:${string}`, focusId?: string | null) => void
  /** 点击左侧导航：点当前已打开的那一项就关闭面板，否则切换过去并打开 */
  toggleView: (view: View) => void
  setPanelOpen: (open: boolean) => void
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
    if (raw) return { characterId: null, groupId: null, chatId: null, panelOpen: true, ...JSON.parse(raw) }
  } catch {
    // 忽略
  }
  return { characterId: null, groupId: null, chatId: null, panelOpen: true }
}

const pick = (s: Selection): Selection => ({
  characterId: s.characterId,
  groupId: s.groupId,
  chatId: s.chatId,
  panelOpen: s.panelOpen,
})

function save(s: Selection) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
  } catch {
    // 忽略
  }
}

export const useUi = create<UiState>((set, get) => ({
  ...load(),
  view: 'chat' as View,
  focusId: null,
  extensionPageId: null,
  previewOpen: false,
  chatSettingsOpen: false,
  sidebarOpen: false,
  openView: (view, focusId = null) => {
    save({ ...pick(get()), panelOpen: true })
    if (view.startsWith('ext:')) {
      const [, extensionId, ...pageId] = view.split(':')
      set({
        view: 'extensions',
        focusId: extensionId || null,
        extensionPageId: pageId.join(':') || null,
        panelOpen: true,
        sidebarOpen: true,
      })
    } else {
      set({ view: view as View, focusId, extensionPageId: null, panelOpen: true, sidebarOpen: true })
    }
  },
  toggleView: (view) => {
    const s = get()
    const panelOpen = !(s.view === view && s.panelOpen)
    save({ ...pick(s), panelOpen })
    set({ view, focusId: null, extensionPageId: null, panelOpen })
  },
  setPanelOpen: (panelOpen) => {
    save({ ...pick(get()), panelOpen })
    set({ panelOpen })
  },
  selectCharacter: (id) => {
    const next = { ...pick(get()), characterId: id, groupId: null }
    save(next)
    set(next)
  },
  selectGroup: (id) => {
    const next = { ...pick(get()), characterId: null, groupId: id }
    save(next)
    set(next)
  },
  openChat: (owner, chatId) => {
    const next = { ...pick(get()), characterId: owner.characterId ?? null, groupId: owner.groupId ?? null, chatId }
    save(next)
    // 手机上选了会话就收起抽屉；宽屏上侧栏保持原样
    set({ ...next, sidebarOpen: false })
  },
  setPreviewOpen: (previewOpen) => set({ previewOpen }),
  setChatSettingsOpen: (chatSettingsOpen) => set({ chatSettingsOpen }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
}))
