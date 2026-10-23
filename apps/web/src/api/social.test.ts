import { expect, spyOn, test } from 'bun:test'
import type { FriendsDTO, LiveEnvelope } from '@nobot/shared'
import { startLive, stopLive, subscribeNotifications, useLiveStore } from './live'
import { queryClient } from './queryClient'
import { socialApi, socialKeys } from './social'

const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(predicate()).toBe(true)
}

test('社交客户端使用正确路径、游标、JSON 与登录凭据', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const mock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init })
        return Response.json({ items: [], nextCursor: null })
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch,
  )
  try {
    await socialApi.lookup('alice')
    await socialApi.friends()
    await socialApi.requestFriend('bob')
    for (const action of ['accept', 'reject', 'cancel'] as const)
      await socialApi.respond({ userId: 'other/id', action })
    await socialApi.removeFriend('other/id')
    await socialApi.blocks()
    await socialApi.block('b')
    await socialApi.unblock('b')
    await socialApi.notifications('12', 20)
    await socialApi.unread()
    await socialApi.read(['12'])
    await socialApi.read()
    await socialApi.dismiss('12')
    await socialApi.presence('invisible')
    expect(calls.map((c) => c.url)).toContain('/api/social/notifications?limit=20&before=12')
    expect(calls.map((c) => c.url)).toContain('/api/social/friends/requests/other%2Fid/accept')
    expect(calls[2]?.init?.body).toBe('{"handle":"bob"}')
    expect(calls.at(-1)?.init?.body).toBe('{"status":"invisible"}')
    expect(calls.every((c) => c.init?.credentials === 'include')).toBe(true)
  } finally {
    mock.mockRestore()
  }
})

test('实时连接单例、事件缓存、通知去重、重连游标、活动节流与退出清理', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const target = new EventTarget()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target })
  let streamController!: ReadableStreamDefaultController<Uint8Array>
  const calls: { url: string; init?: RequestInit }[] = []
  let liveCount = 0
  const mock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, init })
        if (url === '/api/live') {
          liveCount++
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller
              },
            }),
            { headers: { 'Content-Type': 'text/event-stream' } },
          )
        }
        return Response.json({ unreadCount: 3 })
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch,
  )
  let toasts = 0
  const unsubscribe = subscribeNotifications(() => {
    toasts++
  })
  const send = (event: LiveEnvelope) =>
    streamController.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
  try {
    stopLive()
    const friends: FriendsDTO = {
      friends: [{ id: 'b', name: 'Bob', handle: 'bob', presence: { status: 'offline' } }],
      incoming: [],
      outgoing: [],
    }
    queryClient.setQueryData(socialKeys.friends, friends)
    startLive()
    startLive()
    await waitFor(() => liveCount === 1)
    send({
      type: 'hello',
      topic: 'user:a',
      data: { serverTime: 1, cursor: '1', unreadCount: 2, presence: { b: { status: 'online' } } },
    })
    await waitFor(() => useLiveStore.getState().state === 'connected')
    for (const event of ['focus', 'keydown', 'pointerdown', 'input']) target.dispatchEvent(new Event(event))
    expect(calls.filter((c) => c.url === '/api/live/activity')).toHaveLength(1)
    send({ type: 'presence', topic: 'user:b', data: { userId: 'b', presence: { status: 'away' } } })
    await waitFor(() => useLiveStore.getState().presence.b?.status === 'away')
    expect(queryClient.getQueryData<FriendsDTO>(socialKeys.friends)?.friends[0]?.presence.status).toBe('away')
    const notification = {
      id: '2',
      type: 'friend.request',
      actorId: 'b',
      payload: {},
      createdAt: 1,
      readAt: null,
      dismissedAt: null,
    }
    send({ type: 'notification', topic: 'user:a', id: '2', data: notification })
    send({ type: 'notification', topic: 'user:a', id: '2', data: notification })
    await waitFor(() => toasts === 1 && useLiveStore.getState().unreadCount === 3)
    send({ type: 'notification.read', topic: 'user:a', data: { unreadCount: 0 } })
    await waitFor(() => useLiveStore.getState().unreadCount === 0)
    expect(queryClient.getQueryData(socialKeys.unread)).toEqual({ unreadCount: 0 })
    send({ type: 'friends.changed', topic: 'user:a', data: {} })
    await waitFor(() => Object.keys(useLiveStore.getState().presence).length === 0)
    streamController.close()
    await waitFor(() => liveCount === 2)
    expect(new Headers(calls.filter((c) => c.url === '/api/live')[1]?.init?.headers).get('Last-Event-ID')).toBe('2')
    send({ type: 'resync', topic: 'user:a', data: { cursor: '250' } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    streamController.close()
    await waitFor(() => liveCount === 3)
    expect(new Headers(calls.filter((c) => c.url === '/api/live')[2]?.init?.headers).get('Last-Event-ID')).toBe('250')
    stopLive()
    expect(calls.filter((c) => c.url === '/api/live').at(-1)?.init?.signal?.aborted).toBe(true)
    expect(useLiveStore.getState()).toEqual({ state: 'disconnected', presence: {}, unreadCount: 0 })
    expect(queryClient.getQueryData(socialKeys.friends)).toBeUndefined()
    streamController.close()
  } finally {
    stopLive()
    unsubscribe()
    mock.mockRestore()
    queryClient.clear()
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

for (const recovery of ['backoff', 'online', 'visible'] as const) {
  test(`实时静默看门狗、心跳保活与快照恢复：${recovery}`, async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const target = new EventTarget()
    const documentTarget = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: target })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: documentTarget })
    const realTimeout = globalThis.setTimeout
    let now = 100000
    let nextTimer = 0
    const timers = new Map<number, { at: number; run: () => void }>()
    const clock = spyOn(Date, 'now').mockImplementation(() => now)
    const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, delay = 0) => {
      const id = ++nextTimer
      timers.set(id, { at: now + delay, run })
      return id
    }) as typeof setTimeout)
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => {
      timers.delete(id)
    }) as typeof clearTimeout)
    // 只让异步流和查询通知完成，时间推进由测试显式控制。
    const flush = () => new Promise<void>((resolve) => realTimeout(resolve, 0))
    const advance = async (ms: number) => {
      const end = now + ms
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        now = next[1].at
        timers.delete(next[0])
        next[1].run()
        await flush()
      }
      now = end
      await flush()
    }
    const calls: RequestInit[] = []
    let stream!: ReadableStreamDefaultController<Uint8Array>
    const mock = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          if (String(input) !== '/api/live') return Response.json({ ok: true })
          calls.push(init ?? {})
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                stream = controller
                init?.signal?.addEventListener('abort', () =>
                  controller.error(new DOMException('Aborted', 'AbortError')),
                )
              },
            }),
          )
        },
        { preconnect: fetch.preconnect },
      ) as typeof fetch,
    )
    const invalidate = spyOn(queryClient, 'invalidateQueries')
    const cache = spyOn(queryClient, 'setQueryData')
    const send = async (event: LiveEnvelope) => {
      stream.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
      await flush()
    }
    try {
      stopLive()
      startLive()
      await flush()
      await send({
        type: 'hello',
        topic: 'user:a',
        data: { serverTime: now, cursor: '7', unreadCount: 2, presence: { old: { status: 'online' } } },
      })
      expect(useLiveStore.getState().state).toBe('connected')
      const cacheCalls = cache.mock.calls.length
      const invalidations = invalidate.mock.calls.length
      // 超过一个看门狗周期持续收到心跳，连接仍然存活且不会写入查询缓存。
      for (let i = 0; i < 4; i++) {
        await advance(15000)
        await send({ type: 'ping', topic: 'user:a', data: { serverTime: now } })
      }
      expect(calls).toHaveLength(1)
      expect(cache.mock.calls).toHaveLength(cacheCalls)
      expect(invalidate.mock.calls).toHaveLength(invalidations)
      await advance(39999)
      expect(calls[0]?.signal?.aborted).toBe(false)
      if (recovery === 'visible') {
        // 模拟后台冻结定时器：恢复前台时必须按实际静默时长判断过期。
        now += 1
        documentTarget.visibilityState = 'visible'
        documentTarget.dispatchEvent(new Event('visibilitychange'))
        await flush()
      } else {
        await advance(1)
      }
      expect(calls[0]?.signal?.aborted).toBe(true)
      expect(useLiveStore.getState().state).toBe('connecting')
      if (recovery === 'backoff') {
        expect(calls).toHaveLength(1)
        await advance(1000)
      } else if (recovery === 'online') {
        target.dispatchEvent(new Event('online'))
        await flush()
      }
      expect(calls).toHaveLength(2)
      expect(new Headers(calls.at(-1)?.headers).get('Last-Event-ID')).toBe('7')
      const friendsInvalidations = invalidate.mock.calls.filter(
        ([filter]) => filter?.queryKey === socialKeys.friends,
      ).length
      await send({
        type: 'hello',
        topic: 'user:a',
        data: { serverTime: now, cursor: '7', unreadCount: 1, presence: { fresh: { status: 'away' } } },
      })
      expect(useLiveStore.getState().presence).toEqual({ fresh: { status: 'away' } })
      expect(useLiveStore.getState().state).toBe('connected')
      expect(invalidate.mock.calls.filter(([filter]) => filter?.queryKey === socialKeys.friends)).toHaveLength(
        friendsInvalidations + 1,
      )
      stopLive()
      expect(calls.at(-1)?.signal?.aborted).toBe(true)
      const count = calls.length
      target.dispatchEvent(new Event('online'))
      documentTarget.dispatchEvent(new Event('visibilitychange'))
      await advance(60000)
      expect(calls).toHaveLength(count)
      expect(useLiveStore.getState().state).toBe('disconnected')
    } finally {
      stopLive()
      mock.mockRestore()
      invalidate.mockRestore()
      cache.mockRestore()
      queryClient.clear()
      timeout.mockRestore()
      clear.mockRestore()
      clock.mockRestore()
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else Reflect.deleteProperty(globalThis, 'window')
      if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
      else Reflect.deleteProperty(globalThis, 'document')
    }
  })
}
