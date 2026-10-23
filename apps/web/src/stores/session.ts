import type { CurrentUserDTO } from '@nobot/shared'
import { create } from 'zustand'
import { startLive, stopLive } from '../api/live'
import { useSpriteLayout } from './spriteLayout'
import { useUi } from './ui'
import { useVn } from './vn'

export interface SessionState {
  status: 'loading' | 'anonymous' | 'authenticated'
  user: CurrentUserDTO | null
  setupRequired: boolean
  /** 初始化失败时保留原错误，界面可以显示后端提示或提供重试。 */
  error: Error | null
}

export const useSessionStore = create<SessionState>(() => ({
  status: 'loading',
  user: null,
  setupRequired: false,
  error: null,
}))

let revision = 0
let pending: Promise<void> | undefined

/** 统一处理会话失效；不清掉本机偏好，同一用户重新登录后仍可恢复选择。 */
export function setSessionAnonymous() {
  revision++
  // 匿名页面的其他请求也可能返回 401，不能覆盖登录接口给出的首次配置或错误提示。
  if (useSessionStore.getState().status === 'anonymous') return
  useSessionStore.setState({ status: 'anonymous', user: null, setupRequired: false, error: null })
}

/** 没有上次用户记录也要清理：这些可能是升级前留下的服务器数据 ID。 */
export function prepareUserCache(handle: string) {
  let changed = true
  try {
    changed = localStorage.getItem('nobot:lastUser') !== handle
  } catch {
    // 禁用存储时仍清理内存，避免复用未知来源的数据。
  }
  let cleaned = true
  if (changed) {
    try {
      const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      for (const key of keys) {
        if (
          key &&
          ([
            'nobot:selection',
            'nobot:sprite-layout',
            'vn-mode',
            'vn-read',
            'ai-parter:selection',
            'ai-parter:sprite-layout',
          ].includes(key) ||
            key.startsWith('translation:view:'))
        )
          localStorage.removeItem(key)
      }
    } catch {
      cleaned = false
      // 浏览器禁用存储时不阻塞登录；不要记录新用户，确保下次仍重试清理。
    }
    // 模块在 me 返回前就已读取缓存；只删 localStorage 无法清掉 Zustand 中的旧 ID。
    useUi.setState({ characterId: null, groupId: null, chatId: null, focusId: null, extensionPageId: null })
    useVn.setState({ mode: {}, read: [], cinema: {} })
    useSpriteLayout.setState({ vn: {}, side: {}, outfits: {} })
  }
  try {
    if (cleaned) localStorage.setItem('nobot:lastUser', handle)
  } catch {
    // 存储不可用时，本次会话仍可正常使用。
  }
}

/** 启动时只请求一次；失败后可再次调用重试，清理完成后才发布已登录状态。 */
export function initSession(): Promise<void> {
  if (pending) return pending
  const started = ++revision
  useSessionStore.setState({ status: 'loading', user: null, setupRequired: false, error: null })
  pending = (async () => {
    // 延迟导入避免请求层的 401 通知与会话初始化之间形成模块初始化循环。
    const { api, ApiRequestError } = await import('../api/client')
    try {
      const user = await api.authMe()
      if (started !== revision) return
      prepareUserCache(user.handle)
      useSessionStore.setState({ status: 'authenticated', user, setupRequired: false, error: null })
    } catch (error) {
      if (started !== revision) return
      const unauthorized = error instanceof ApiRequestError && error.status === 401
      useSessionStore.setState({
        status: 'anonymous',
        user: null,
        setupRequired: error instanceof ApiRequestError && error.code === 'SETUP_REQUIRED',
        error: unauthorized ? null : error instanceof Error ? error : new Error(String(error)),
      })
    }
  })().finally(() => {
    pending = undefined
  })
  return pending
}

// 会话状态是每个标签唯一的启动入口，401 和退出都会释放同一条连接。
useSessionStore.subscribe((state, previous) => {
  if (state.status === 'authenticated' && state.user?.id !== previous.user?.id) {
    stopLive()
    startLive()
  } else if (state.status !== 'authenticated') stopLive()
})
