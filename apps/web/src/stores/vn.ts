import type { PlayPresetData } from '@nobot/shared'
import { useEffect } from 'react'
import { create } from 'zustand'

/**
 * VN 视图的界面状态（只存在这台设备的浏览器里，属于个人偏好，不进数据库）：
 * - mode：每个会话选的视图。没选过的会话按玩法预设的「默认以 VN 视图打开」决定
 * - read：读过的拍（`消息 id:拍序号`），「快进只跳读过的」靠它；只保留最近的一部分，免得无限增长
 */
const MODE_KEY = 'vn-mode'
const READ_KEY = 'vn-read'
const READ_LIMIT = 5000

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 隐私模式或存储满了：本次会话里照样能用，只是不记住
  }
}

interface VnState {
  mode: Record<string, 'vn' | 'chat'>
  cinema: Record<string, boolean>
  toggleCinema: (chatId: string, presetDefault?: boolean) => void
  read: string[]
  setMode: (chatId: string, mode: 'vn' | 'chat') => void
  markRead: (keys: string[]) => void
}

export const useVn = create<VnState>((set, get) => ({
  mode: load(MODE_KEY, {}),
  cinema: {},
  toggleCinema: (chatId, presetDefault = false) =>
    set({ cinema: { ...get().cinema, [chatId]: !(get().cinema[chatId] ?? presetDefault) } }),
  read: load(READ_KEY, []),
  setMode: (chatId, mode) => {
    const next = { ...get().mode, [chatId]: mode }
    save(MODE_KEY, next)
    set({ mode: next })
  },
  markRead: (keys) => {
    const known = new Set(get().read)
    const fresh = keys.filter((k) => !known.has(k))
    if (!fresh.length) return
    const next = [...get().read, ...fresh].slice(-READ_LIMIT)
    save(READ_KEY, next)
    set({ read: next })
  },
}))

/** 这个会话现在该用哪个视图：自己选过就用选过的，否则按预设默认 */
export function useVnMode(chatId: string, presetDefault: boolean): boolean {
  const chosen = useVn((s) => s.mode[chatId])
  return chosen ? chosen === 'vn' : presetDefault
}

/** 临时电影模式只在内存中按会话记录，尚未切换时跟随当前玩法预设。 */
export function useCinema(chatId: string, presetDefault: boolean): boolean {
  return useVn((state) => state.cinema[chatId] ?? presetDefault)
}

/**
 * 背景切换的转场：聊天页按当前会话的玩法预设设置，Background 组件读取。
 * dissolve：新图在旧图上面淡入（交叉溶解）；fade：旧图淡出到黑、新图淡入；none：直接切换
 */
export interface StageTransition {
  kind: 'none' | 'fade' | 'dissolve'
  ms: number
}
export const useStageTransition = create<{ value: StageTransition; set: (value: StageTransition) => void }>((set) => ({
  value: { kind: 'dissolve', ms: 300 },
  set: (value) => set({ value }),
}))

/** 按当前会话预设同步全局背景转场；关闭舞台指令时恢复默认值。 */
export function useSyncStageTransition(play: PlayPresetData | undefined) {
  const set = useStageTransition((state) => state.set)
  const kind = play?.directives.enabled ? play.stage.transition : 'dissolve'
  const ms = play?.directives.enabled ? play.stage.transitionMs : 300
  useEffect(() => set({ kind, ms }), [set, kind, ms])
}
