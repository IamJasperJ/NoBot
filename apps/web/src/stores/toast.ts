import { create } from 'zustand'

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
export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))
