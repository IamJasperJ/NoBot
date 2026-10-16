import { create } from 'zustand'

/**
 * 外观设置：主题、字号、对话区宽度、侧栏宽度等。
 * 这些是「这台设备上怎么看」的偏好，所以存在浏览器的 localStorage 里，不存数据库
 * （手机和电脑可以各用各的设置）。
 */
export interface Appearance {
  /** 主题：跟随系统 / 浅色 / 深色 */
  theme: 'system' | 'light' | 'dark'
  /** 界面整体缩放（根字号，px），影响所有文字和间距 */
  uiScale: number
  /** 消息正文字号（px） */
  messageFontSize: number
  /** 消息正文行距 */
  messageLineHeight: number
  /** 对话区最大宽度（px）；0 表示铺满 */
  chatWidth: number
  /** 对话区位置：居中 / 靠左 */
  chatAlign: 'center' | 'left'
  /** 聊天侧栏宽度（px） */
  sidebarWidth: number
  /** 是否显示消息头像 */
  bgDim: number
  /** 有背景时侧边面板（以及覆盖层编辑器）的不透明度，20–100（%），越小越能看到背景 */
  panelOpacity: number
  bgBlur: number
  bgFit: 'cover' | 'contain' | 'stretch' | 'center'
  bgAnimate: boolean
  showAvatars: boolean
}

export const DEFAULT_APPEARANCE: Appearance = {
  bgDim: 0,
  panelOpacity: 82,
  bgBlur: 0,
  bgFit: 'cover',
  bgAnimate: true,
  theme: 'system',
  uiScale: 16,
  messageFontSize: 15,
  messageLineHeight: 1.7,
  chatWidth: 768,
  chatAlign: 'center',
  sidebarWidth: 288,
  showAvatars: true,
}

export const SIDEBAR_MIN = 220
export const SIDEBAR_MAX = 520

const STORAGE_KEY = 'ai-parter:appearance'

function load(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULT_APPEARANCE, ...JSON.parse(raw) }
  } catch {
    // localStorage 不可用或内容损坏时用默认值
  }
  return DEFAULT_APPEARANCE
}

interface AppearanceState extends Appearance {
  set: (patch: Partial<Appearance>) => void
  reset: () => void
}

export const useAppearance = create<AppearanceState>((set, get) => ({
  ...load(),
  set: (patch) => {
    set(patch)
    persist(get())
  },
  reset: () => {
    set(DEFAULT_APPEARANCE)
    persist(DEFAULT_APPEARANCE)
  },
}))

function persist(state: Appearance) {
  const data: Appearance = {
    bgDim: state.bgDim,
    panelOpacity: state.panelOpacity,
    bgBlur: state.bgBlur,
    bgFit: state.bgFit,
    bgAnimate: state.bgAnimate,
    theme: state.theme,
    uiScale: state.uiScale,
    messageFontSize: state.messageFontSize,
    messageLineHeight: state.messageLineHeight,
    chatWidth: state.chatWidth,
    chatAlign: state.chatAlign,
    sidebarWidth: state.sidebarWidth,
    showAvatars: state.showAvatars,
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    // 忽略
  }
}

/**
 * 把外观设置应用到页面：主题用 <html> 上的 dark class（Tailwind 的 dark: 变体跟着它走），
 * 其余用 CSS 变量，组件里通过 var(--xxx) 读取。
 */
export function applyAppearance(a: Appearance) {
  const root = document.documentElement
  const dark = a.theme === 'dark' || (a.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  root.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
  root.style.fontSize = `${a.uiScale}px`
  root.style.setProperty('--panel-alpha', `${Math.min(100, Math.max(20, a.panelOpacity))}%`)
  root.style.setProperty('--msg-font-size', `${a.messageFontSize}px`)
  root.style.setProperty('--msg-line-height', String(a.messageLineHeight))
  root.style.setProperty('--chat-width', a.chatWidth > 0 ? `${a.chatWidth}px` : '100%')
  root.dataset.chatAlign = a.chatAlign
  root.style.setProperty('--sidebar-width', `${a.sidebarWidth}px`)
  root.toggleAttribute('data-hide-avatars', !a.showAvatars)
}

/** 启动时调用：应用一次，之后设置变化或系统主题变化时自动重新应用 */
export function initAppearance() {
  applyAppearance(useAppearance.getState())
  useAppearance.subscribe((s) => applyAppearance(s))
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyAppearance(useAppearance.getState()))
}
