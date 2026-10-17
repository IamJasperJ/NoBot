import { create } from 'zustand'

/**
 * 聊天里的两种临时操作状态（不持久化）：
 * - 多选：勾选多条消息，一起「不发给模型 / 恢复发送」。按住 Shift 点选，选中上次点的那条到这条之间的全部
 * - 跳转：书签等地方要求消息列表滚动到某条消息并高亮一下
 */
interface ChatOpsState {
  /** 正在多选的会话；null 表示不在多选模式 */
  selectingChat: string | null
  selected: string[]
  /** 上一次点选的消息，Shift 范围选择的起点 */
  anchor: string | null
  startSelect: (chatId: string, first?: string) => void
  /** order 是当前列表里消息 id 的顺序，Shift 范围选择要用 */
  toggle: (id: string, range: boolean, order: string[]) => void
  setSelected: (ids: string[]) => void
  stopSelect: () => void

  /** 正在调整侧边立绘的会话（拖动、缩放）；null 表示没在调整 */
  sideAdjusting: string | null
  setSideAdjusting: (chatId: string | null) => void
  /** 打开「切换立绘套装」面板的会话 */
  outfitPicker: string | null
  setOutfitPicker: (chatId: string | null) => void

  jump: { chatId: string; messageId: string; nonce: number } | null
  jumpTo: (chatId: string, messageId: string) => void
  clearJump: () => void
}

export const useChatOps = create<ChatOpsState>()((set, get) => ({
  selectingChat: null,
  selected: [],
  anchor: null,
  startSelect: (chatId, first) => set({ selectingChat: chatId, selected: first ? [first] : [], anchor: first ?? null }),
  toggle: (id, range, order) => {
    const { selected, anchor } = get()
    if (range && anchor && anchor !== id) {
      const a = order.indexOf(anchor)
      const b = order.indexOf(id)
      if (a >= 0 && b >= 0) {
        const span = order.slice(Math.min(a, b), Math.max(a, b) + 1)
        set({ selected: [...new Set([...selected, ...span])], anchor: id })
        return
      }
    }
    set({ selected: selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id], anchor: id })
  },
  setSelected: (ids) => set({ selected: ids }),
  stopSelect: () => set({ selectingChat: null, selected: [], anchor: null }),

  sideAdjusting: null,
  setSideAdjusting: (sideAdjusting) => set({ sideAdjusting }),
  outfitPicker: null,
  setOutfitPicker: (outfitPicker) => set({ outfitPicker }),

  jump: null,
  jumpTo: (chatId, messageId) => set({ jump: { chatId, messageId, nonce: Date.now() } }),
  clearJump: () => set({ jump: null }),
}))
