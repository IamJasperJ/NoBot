import { type FriendsDTO, type LiveEvent, type NotificationDTO, type PresenceDTO, parseSSE } from '@nobot/shared'
import { create } from 'zustand'
import { channelKeys } from './channels'
import { apiFetch } from './fetch'
import { queryClient } from './queryClient'
import { applyRoomLive, clearRoomSession, roomKeys, roomLiveConnected } from './rooms'
import { socialKeys } from './social'

export const useLiveStore = create<{
  state: 'disconnected' | 'connecting' | 'connected'
  presence: Record<string, PresenceDTO>
  unreadCount: number
}>(() => ({ state: 'disconnected', presence: {}, unreadCount: 0 }))
const listeners = new Set<(notification: NotificationDTO) => void>()
/** 视觉层可以订阅新通知；重连补发按游标去重。 */
export function subscribeNotifications(listener: (notification: NotificationDTO) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
let stop: (() => void) | undefined
export function stopLive() {
  stop?.()
  stop = undefined
}
export function startLive() {
  if (stop || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  const controller = new AbortController()
  let cursor: string | null = null
  let snapshotCursor: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined
  let connection: AbortController | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let deadline = Infinity
  let watchdogExpired = false
  let reconnectImmediately = false
  const expire = () => {
    watchdogExpired = true
    useLiveStore.setState({ state: 'connecting' })
    connection?.abort()
  }
  const resetWatchdog = () => {
    clearTimeout(watchdog)
    watchdogExpired = false
    deadline = Date.now() + 40000
    watchdog = setTimeout(expire, 40000)
  }
  // 后台标签页可能暂停定时器，恢复时也要按截止时间判断连接是否失活。
  const resume = () => {
    if (controller.signal.aborted || (!watchdogExpired && Date.now() < deadline)) return
    reconnectImmediately = true
    expire()
    clearTimeout(timer)
    wake?.()
  }
  const visible = () => {
    if (document.visibilityState === 'visible') resume()
  }
  window.addEventListener('online', resume)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visible)
  let lastActivity = -Infinity
  const activity = () => {
    if (Date.now() - lastActivity < 60000) return
    lastActivity = Date.now()
    void apiFetch('/api/live/activity', { method: 'POST', credentials: 'include', signal: controller.signal }).catch(
      () => {},
    )
  }
  const events = ['focus', 'keydown', 'pointerdown', 'pointermove', 'input'] as const
  for (const event of events) window.addEventListener(event, activity, { passive: true })
  const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return
    if (JSON.stringify(event.query.queryKey) === JSON.stringify(socialKeys.friends)) {
      const friends = queryClient.getQueryData<FriendsDTO>(socialKeys.friends)
      if (friends)
        useLiveStore.setState({ presence: Object.fromEntries(friends.friends.map((f) => [f.id, f.presence])) })
    }
    if (JSON.stringify(event.query.queryKey) === JSON.stringify(socialKeys.unread)) {
      const data = queryClient.getQueryData<{ unreadCount: number }>(socialKeys.unread)
      if (data) useLiveStore.setState(data)
    }
  })
  stop = () => {
    clearRoomSession()
    unsubscribeCache()
    controller.abort()
    connection?.abort()
    clearTimeout(watchdog)
    clearTimeout(timer)
    wake?.()
    window.removeEventListener('online', resume)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visible)
    for (const event of events) window.removeEventListener(event, activity)
    useLiveStore.setState({ state: 'disconnected', presence: {}, unreadCount: 0 })
    queryClient.removeQueries({ queryKey: socialKeys.all })
    queryClient.removeQueries({ queryKey: channelKeys.all })
  }
  const dispatch = (event: LiveEvent) => {
    if (event.type.startsWith('room.')) {
      applyRoomLive(event.type, event.data)
      return
    }
    switch (event.type) {
      case 'channel.account':
      case 'channel.request':
        void queryClient.invalidateQueries({ queryKey: channelKeys.all })
        break
      case 'hello':
        void queryClient.invalidateQueries({ queryKey: channelKeys.all })
        if (event.data.connectionId) roomLiveConnected(event.data.connectionId)
        snapshotCursor = event.data.cursor
        if (cursor === null) cursor = event.data.cursor
        useLiveStore.setState({
          state: 'connected',
          presence: event.data.presence,
          unreadCount: event.data.unreadCount,
        })
        queryClient.setQueryData(socialKeys.unread, { unreadCount: event.data.unreadCount })
        // 快照同时移除失去好友资格的旧状态，不能继续显示缓存的在线信息。
        void queryClient.invalidateQueries({ queryKey: socialKeys.friends })
        break
      case 'presence':
        useLiveStore.setState((s) => ({ presence: { ...s.presence, [event.data.userId]: event.data.presence } }))
        queryClient.setQueryData<FriendsDTO>(socialKeys.friends, (old) =>
          old
            ? {
                ...old,
                friends: old.friends.map((f) =>
                  f.id === event.data.userId ? { ...f, presence: event.data.presence } : f,
                ),
              }
            : old,
        )
        break
      case 'notification':
        if (event.data.type.startsWith('room.')) void queryClient.invalidateQueries({ queryKey: roomKeys.all })
        if (cursor && Number(event.id) <= Number(cursor)) break
        cursor = event.id
        if (event.data.dismissedAt === null && event.data.readAt === null) {
          // hello 已包含补发通知的未读数，只累加快照之后新产生的通知。
          if (snapshotCursor === null || Number(event.id) > Number(snapshotCursor)) {
            const unreadCount = useLiveStore.getState().unreadCount + 1
            useLiveStore.setState({ unreadCount })
            queryClient.setQueryData(socialKeys.unread, { unreadCount })
          }
          for (const listener of listeners) {
            try {
              listener(event.data)
            } catch {
              /* 一个界面订阅失败不能打断事件流。 */
            }
          }
        }
        void queryClient.invalidateQueries({ queryKey: socialKeys.notifications })
        void queryClient.invalidateQueries({ queryKey: socialKeys.unread })
        break
      case 'notification.read':
        useLiveStore.setState({ unreadCount: event.data.unreadCount })
        queryClient.setQueryData(socialKeys.unread, event.data)
        void queryClient.invalidateQueries({ queryKey: socialKeys.notifications })
        break
      case 'friends.changed':
        useLiveStore.setState({ presence: {} })
        void queryClient.invalidateQueries({ queryKey: socialKeys.all })
        break
      case 'resync':
        cursor = event.data.cursor
        void queryClient.invalidateQueries({ queryKey: socialKeys.all })
        break
    }
  }
  void (async () => {
    let failures = 0
    while (!controller.signal.aborted) {
      useLiveStore.setState({ state: 'connecting' })
      connection = new AbortController()
      resetWatchdog()
      try {
        const response = await apiFetch('/api/live', {
          credentials: 'include',
          signal: connection.signal,
          headers: cursor ? { 'Last-Event-ID': cursor } : {},
        })
        if (response.status === 401) break
        if (!response.ok || !response.body) throw new Error(String(response.status))
        for await (const message of parseSSE(response.body)) {
          if (controller.signal.aborted || connection.signal.aborted) break
          resetWatchdog()
          const event = JSON.parse(message.data) as LiveEvent
          if (event.type === 'hello') {
            failures = 0
            activity()
          }
          if (event.type !== 'ping') dispatch(event)
        }
      } catch {
        /* 网络恢复后继续从最后的持久通知游标补发。 */
      } finally {
        clearTimeout(watchdog)
        connection = undefined
      }
      if (controller.signal.aborted) break
      useLiveStore.setState({ state: 'connecting' })
      if (reconnectImmediately) {
        reconnectImmediately = false
        continue
      }
      await new Promise<void>((resolve) => {
        wake = resolve
        timer = setTimeout(resolve, Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)))
      })
      wake = undefined
      reconnectImmediately = false
    }
  })()
}
