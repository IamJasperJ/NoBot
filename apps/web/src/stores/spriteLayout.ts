import { create } from 'zustand'

/**
 * 立绘的手动位置和大小（拖动、滚轮缩放调出来的）。这是「这台设备上怎么看」的偏好，存在 localStorage，不进聊天数据：
 * - VN 舞台：按「会话 + 演员」记，另外每个会话有一个整体缩放
 * - 聊天视图的侧边立绘：按角色记（不同角色的立绘构图不一样）
 * - 立绘套装（服装）：按「会话 + 角色」记手动选的服装，优先于模型在舞台指令里写的；清掉就回到跟随剧情
 * x、y 是相对位置的偏移（占舞台宽 / 高的百分比），scale 是在预设「立绘缩放」之上再乘的倍数
 */
export interface SpriteAdjust {
  /** 横向位置（舞台宽度的百分比，0–100）；没有时按站位自动排 */
  x?: number
  /** 纵向偏移（舞台高度的百分比，正数往下） */
  y?: number
  scale?: number
}

interface State {
  vn: Record<string, { all?: number; actors: Record<string, SpriteAdjust> }>
  side: Record<string, SpriteAdjust>
  /** 会话 id → 角色 id → 手动选的服装（'' 是默认服装） */
  outfits: Record<string, Record<string, string>>
  /** outfit 为 null 表示跟随剧情 */
  setOutfit: (chatId: string, characterId: string, outfit: string | null) => void
  setActor: (chatId: string, actorKey: string, patch: SpriteAdjust) => void
  setAll: (chatId: string, scale: number) => void
  resetActor: (chatId: string, actorKey: string) => void
  resetChat: (chatId: string) => void
  setSide: (characterId: string, patch: SpriteAdjust) => void
  resetSide: (characterId: string) => void
}

const KEY = 'ai-parter:sprite-layout'
export const SCALE_MIN = 0.3
export const SCALE_MAX = 3
export const clampScale = (value: number) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(value * 100) / 100))

type Saved = Pick<State, 'vn' | 'side' | 'outfits'>

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const data = JSON.parse(raw) as Partial<Saved>
      return { vn: data.vn ?? {}, side: data.side ?? {}, outfits: data.outfits ?? {} }
    }
  } catch {
    // localStorage 不可用或内容坏了：从空的开始
  }
  return { vn: {}, side: {}, outfits: {} }
}

export const useSpriteLayout = create<State>()((set, get) => {
  // 拖动时每一帧都在改，写 localStorage 要攒一下（停手 300ms 后写一次），不然拖起来会卡
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        const { vn, side, outfits } = get()
        localStorage.setItem(KEY, JSON.stringify({ vn, side, outfits }))
      } catch {
        // 忽略
      }
    }, 300)
  }
  const update = (fn: (s: State) => Partial<State>) => {
    set(fn)
    save()
  }
  return {
    ...load(),
    setOutfit: (chatId, characterId, outfit) =>
      update((s) => {
        const { [characterId]: _, ...rest } = s.outfits[chatId] ?? {}
        return { outfits: { ...s.outfits, [chatId]: outfit === null ? rest : { ...rest, [characterId]: outfit } } }
      }),
    setActor: (chatId, actorKey, patch) =>
      update((s) => {
        const chat = s.vn[chatId] ?? { actors: {} }
        const actor = { ...chat.actors[actorKey], ...patch }
        if (actor.scale !== undefined) actor.scale = clampScale(actor.scale)
        return { vn: { ...s.vn, [chatId]: { ...chat, actors: { ...chat.actors, [actorKey]: actor } } } }
      }),
    setAll: (chatId, scale) =>
      update((s) => ({
        vn: { ...s.vn, [chatId]: { actors: s.vn[chatId]?.actors ?? {}, all: clampScale(scale) } },
      })),
    resetActor: (chatId, actorKey) =>
      update((s) => {
        const chat = s.vn[chatId]
        if (!chat) return {}
        const { [actorKey]: _, ...actors } = chat.actors
        return { vn: { ...s.vn, [chatId]: { ...chat, actors } } }
      }),
    resetChat: (chatId) =>
      update((s) => {
        const { [chatId]: _, ...vn } = s.vn
        return { vn }
      }),
    setSide: (characterId, patch) =>
      update((s) => {
        const next = { ...s.side[characterId], ...patch }
        if (next.scale !== undefined) next.scale = clampScale(next.scale)
        return { side: { ...s.side, [characterId]: next } }
      }),
    resetSide: (characterId) =>
      update((s) => {
        const { [characterId]: _, ...side } = s.side
        return { side }
      }),
  }
})
