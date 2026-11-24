import { useEffect, useReducer, useSyncExternalStore } from 'react'
import { create } from 'zustand'

/** 自动翻译是当前最长的消息完成等待窗口。 */
export const FRESH_MESSAGE_MAX_MS = 60_000

// 只在 SSE 消息完成时登记；历史查询和缓存刷新不能让旧消息重新播放动画。
export const useFreshMessages = create<{ completedAt: ReadonlyMap<string, number> }>(() => ({ completedAt: new Map() }))

export function registerFreshMessage(messageId: string) {
  if (!messageId) return
  const now = Date.now()
  useFreshMessages.setState(({ completedAt }) => {
    const fresh = new Map<string, number>()
    for (const [id, at] of completedAt) if (now - at < FRESH_MESSAGE_MAX_MS) fresh.set(id, at)
    fresh.set(messageId, now)
    return { completedAt: fresh }
  })
}

/** 到期主动触发渲染，既服务骰子动画，也服务自动翻译的等待窗口。 */
export function useFreshMessage(messageId: string, ms: number): boolean {
  const snapshot = () => useFreshMessages.getState().completedAt.get(messageId)
  const completedAt = useSyncExternalStore(useFreshMessages.subscribe, snapshot, snapshot)
  const [, refresh] = useReducer((value: number) => value + 1, 0)
  const remaining = completedAt === undefined ? 0 : completedAt + ms - Date.now()
  useEffect(() => {
    if (remaining <= 0) return
    const timer = setTimeout(refresh, remaining)
    return () => clearTimeout(timer)
  }, [completedAt, ms, remaining])
  return !!messageId && remaining > 0
}
