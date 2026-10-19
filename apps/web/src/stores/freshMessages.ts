import { useEffect, useReducer, useSyncExternalStore } from 'react'
import { create } from 'zustand'

// 只在 SSE 消息完成时登记；历史查询和缓存刷新不能让旧消息重新播放动画。
export const useFreshMessages = create<{ completedAt: ReadonlyMap<string, number> }>(() => ({ completedAt: new Map() }))

export function registerFreshMessage(messageId: string) {
  if (!messageId) return
  useFreshMessages.setState(({ completedAt }) => ({ completedAt: new Map(completedAt).set(messageId, Date.now()) }))
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
