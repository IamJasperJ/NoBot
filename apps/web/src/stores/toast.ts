import { create } from 'zustand'
import { t } from '../i18n'

export interface Toast {
  id: number
  kind: 'error' | 'info'
  message: string
}

interface ToastState {
  toasts: Toast[]
  push: (kind: Toast['kind'], message: string) => void
  dismiss: (id: number) => void
}

let nextId = 1

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, message) => {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }))
    // 错误多停留一会儿，方便看清
    setTimeout(() => get().dismiss(id), kind === 'error' ? 8000 : 3000)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

/** 在组件外也能直接调用 */
export const toast = {
  error: (message: string) => useToasts.getState().push('error', message),
  info: (message: string) => useToasts.getState().push('info', message),
}

/** 把任意异常转成提示文字 */
/** 额度类提示：在原文后面补上几点恢复 */
export const withResetTime = (message: string, resetAt: number) =>
  t('{message}（{time} 恢复）', {
    message,
    time: new Date(resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  })

/**
 * 把错误变成给用户看的文字：fetch 自身的网络错误（TypeError「Failed to fetch」等）换成中文说明；
 * 带 resetAt 的（房间 AI 额度用完）补上恢复时间
 */
export const errorMessage = (e: unknown) => {
  if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) return t('连不上服务器，请检查网络后重试')
  if (!(e instanceof Error)) return String(e)
  const resetAt = (e as { resetAt?: unknown }).resetAt
  return typeof resetAt === 'number' ? withResetTime(e.message, resetAt) : e.message
}
