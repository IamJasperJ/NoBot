import { afterEach, expect, spyOn, test } from 'bun:test'
import type { ChatPage, MessageDTO, RoomDTO } from '@nobot/shared'
import { useRoomLive } from '../stores/room'
import { useStreaming } from '../stores/streaming'
import { message } from './hooks.test-utils'
import { flattenPages, keys } from './queries'
import { queryClient } from './queryClient'
import { removeRoomScope, scopedApiPath, scopeRoomData, setRoomScope } from './room-scope'
import {
  applyRoomLive,
  clearRoomSession,
  joinInviteFromPath,
  mergeMessage,
  roomInviteDestination,
  roomKeys,
  scopeForChat,
} from './rooms'

afterEach(() => {
  clearRoomSession()
  queryClient.clear()
})

test('房间 scope 按聊天和消息路由，资源 URL 重写幂等，其他私有列表仍留在自己的上下文', () => {
  setRoomScope({ id: 'room-a', chatId: 'chat-a' })
  expect(scopedApiPath('/api/chats/chat-a?before=old')).toBe('/api/rooms/room-a/scope/chats/chat-a?before=old')
  expect(scopedApiPath('/api/chats/chat-b')).toBe('/api/chats/chat-b')
  expect(scopedApiPath('/api/connections')).toBe('/api/connections')
  const data = scopeRoomData(
    {
      id: 'msg',
      avatar: '/api/assets/avatars/avatar.webp',
      characterId: 'char',
      nested: [{ url: '/api/assets/attachments/img.webp' }],
    },
    'room-a',
  )
  expect(data.avatar).toBe('/api/rooms/room-a/scope/assets/avatars/avatar.webp')
  expect(scopeRoomData(data, 'room-a')).toEqual(data)
  expect(scopedApiPath('/api/messages/msg')).toBe('/api/rooms/room-a/scope/messages/msg')
  expect(scopedApiPath('/api/characters/char/sprites')).toBe('/api/rooms/room-a/scope/characters/char/sprites')
  removeRoomScope('chat-a')
  expect(scopedApiPath('/api/messages/msg')).toBe('/api/messages/msg')
})

test('两个会话并行流互不串字，结束一个保留另一个；单人调用兼容', () => {
  const s = useStreaming.getState()
  s.begin('a', 'one', 'old')
  s.begin('b', 'two')
  s.append(' A', 'thinking A', 'a')
  s.append('B', 'thinking B', 'b')
  expect(useStreaming.getState().streams.a).toEqual({ messageId: 'one', text: 'old A', reasoning: 'thinking A' })
  expect(useStreaming.getState().streams.b).toEqual({ messageId: 'two', text: 'B', reasoning: 'thinking B' })
  s.end('b')
  expect(useStreaming.getState().chatId).toBe('a')
  s.append('!', '')
  expect(useStreaming.getState().text).toBe('old A!')
  s.end()
  expect(useStreaming.getState().streams).toEqual({})
})

const makeMessage = (id: string, parentId: string | null): MessageDTO => ({
  ...message,
  id,
  parentId,
  chatId: 'chat-a',
  meta: {},
})
function setupCache(messages: MessageDTO[]) {
  queryClient.setQueryData(keys.chat('chat-a'), {
    pages: [{ messages, generating: false, chat: { id: 'chat-a' } } as ChatPage],
    pageParams: [undefined],
  })
}

test('权威事件与 HTTP 响应去重，编辑早期消息不丢后续消息，乐观消息合并', () => {
  const first = makeMessage('first', null),
    second = makeMessage('second', 'first')
  setupCache([first, second])
  mergeMessage({ ...first, content: 'edited' })
  expect(flattenPages(queryClient.getQueryData(keys.chat('chat-a'))).map((m) => m.id)).toEqual(['first', 'second'])
  const last = { ...makeMessage('last', 'second'), meta: { clientMessageId: 'client' } }
  mergeMessage({ ...last, id: 'optimistic:client' })
  mergeMessage(last)
  mergeMessage(last)
  expect(flattenPages(queryClient.getQueryData(keys.chat('chat-a'))).map((m) => m.id)).toEqual([
    'first',
    'second',
    'last',
  ])
})

test('room live 按 seq 去重并隔离聊天流，被踢清掉 scope、消息与增量缓存', () => {
  const room = { id: 'room-a', chatId: 'chat-a' } as RoomDTO
  setRoomScope(room)
  queryClient.setQueryData(roomKeys.detail(room.id), room)
  setupCache([makeMessage('root', null)])
  const reply = { ...makeMessage('reply', 'root'), content: '' }
  const emit = (payload: Record<string, unknown>, seq?: number) =>
    applyRoomLive('room.generation', { roomId: room.id, seq, payload })
  emit({ type: 'start', assistantMessage: reply })
  emit({ type: 'delta', messageId: reply.id, text: 'Hello', index: 1 })
  emit({ type: 'delta', messageId: reply.id, text: 'duplicate', index: 1 })
  emit({ type: 'delta', messageId: 'old-message', text: 'stale', index: 2 })
  expect(useStreaming.getState().streams['chat-a']?.text).toBe('Hello')
  emit({ type: 'done', message: { ...reply, content: 'Hello' } }, 1)
  emit({ type: 'done', message: { ...reply, content: 'duplicate' } }, 1)
  expect(flattenPages(queryClient.getQueryData(keys.chat('chat-a'))).at(-1)?.content).toBe('Hello')
  applyRoomLive('room.turn', { roomId: room.id, payload: { running: true, pendingCount: 2 } })
  expect(useRoomLive.getState().turns[room.id]?.pendingCount).toBe(2)
  applyRoomLive('room.removed', { roomId: room.id })
  expect(queryClient.getQueryData(keys.chat('chat-a'))).toBeUndefined()
  expect(scopedApiPath('/api/chats/chat-a')).toBe('/api/chats/chat-a')
  expect(useStreaming.getState().streams['chat-a']).toBeUndefined()
})

test('邀请通知与 /join 链接暴露大厅数据入口，不需要新增视觉组件', () => {
  expect(joinInviteFromPath('/join/abc_123')).toBe('abc_123')
  expect(joinInviteFromPath('/join/token/extra')).toBeNull()
  expect(
    roomInviteDestination({
      id: '1',
      type: 'room.invite',
      actorId: 'a',
      payload: { inviteId: 'invite' },
      createdAt: 1,
      readAt: null,
      dismissedAt: null,
    }),
  ).toEqual({ invite: 'invite', path: '/join/invite' })
})

test('输入状态五秒过期，旧的到期回调不能清除更新的输入状态', () => {
  let now = 10000
  const callbacks: (() => void)[] = []
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  const fakeTimer = ((handler: Parameters<typeof setTimeout>[0]) => {
    if (typeof handler === 'function') callbacks.push(handler)
    return 1 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(fakeTimer)
  try {
    useRoomLive.getState().setTyping('room', 'bob', now + 5000)
    now += 4000
    useRoomLive.getState().setTyping('room', 'bob', now + 5000)
    now += 1000
    callbacks[0]!()
    expect(useRoomLive.getState().typing.room?.bob).toBe(19000)
    now += 4000
    callbacks[1]!()
    expect(useRoomLive.getState().typing.room?.bob).toBeUndefined()
  } finally {
    timer.mockRestore()
    clock.mockRestore()
  }
})

test('房主保留普通 API，角色变更更新 scope，过期游标 resync 后仍接收新事件', () => {
  const room = { id: 'room-a', chatId: 'chat-a', myRole: 'owner' } as RoomDTO
  setRoomScope(room)
  expect(scopedApiPath('/api/chats/chat-a')).toBe('/api/chats/chat-a')
  expect(scopedApiPath('/api/chats/chat-a/settings')).toBe('/api/chats/chat-a/settings')
  expect(scopedApiPath('/api/chats/chat-a/generate')).toBe('/api/rooms/room-a/scope/chats/chat-a/generate')
  setRoomScope({ ...room, myRole: 'player' })
  expect(scopedApiPath('/api/chats/chat-a')).toBe('/api/rooms/room-a/scope/chats/chat-a')
  queryClient.setQueryData(roomKeys.detail(room.id), room)
  setupCache([])
  applyRoomLive('room.message', { roomId: room.id, seq: 100, payload: {} })
  applyRoomLive('room.resync', { roomId: room.id, seq: 10 })
  applyRoomLive('room.message', { roomId: room.id, seq: 11, payload: { message: makeMessage('new', null) } })
  expect(flattenPages(queryClient.getQueryData(keys.chat('chat-a'))).at(-1)?.id).toBe('new')
})

test('访客刷新先解析房间列表，再发 scoped 聊天请求；书签和个人预设查询禁用', async () => {
  const { setupHooks } = await import('./hooks.test-utils')
  const { useChatPages, useBookmarks, usePersonas, usePlayPresets, useChatProfile } = await import('./queries')
  const { roomsApi, canSeeRollResult } = await import('./rooms')
  const { qc, render } = setupHooks()
  const requests: string[] = []
  const room = { id: 'guest-room', chatId: 'host-chat', myRole: 'player' } as RoomDTO
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const path = String(input)
        requests.push(path)
        return Response.json(
          path === '/api/rooms' ? [room] : { messages: [], chat: { id: 'host-chat' }, hasMore: false },
        )
      },
      { preconnect: fetch.preconnect },
    ),
  )
  try {
    const initial = render(() => useChatPages('host-chat'))
    expect(initial.isEnabled).toBe(false)
    expect(requests).toEqual([])
    const rooms = await roomsApi.list()
    qc.setQueryData(roomKeys.list, rooms)
    const pages = render(() => useChatPages('host-chat'))
    expect(pages.isEnabled).toBe(true)
    await pages.refetch()
    expect(render(() => useBookmarks('host-chat')).isEnabled).toBe(false)
    expect(render(() => usePersonas('host-chat')).isEnabled).toBe(false)
    expect(render(() => usePlayPresets('host-chat')).isEnabled).toBe(false)
    expect(render(() => useChatProfile('host-chat')).isEnabled).toBe(false)
    expect(requests).toEqual(['/api/rooms', '/api/rooms/guest-room/scope/chats/host-chat'])
    expect(canSeeRollResult({ ...message, meta: { hidden: { reason: 'blind' } } })).toBe(false)
    expect(canSeeRollResult(message)).toBe(true)
  } finally {
    fetchMock.mockRestore()
    qc.clear()
  }
})

test('MP4 数据接口保持房间作用域、提案与排期载荷完整，转让需要显式接受', async () => {
  const { roomsApi } = await import('./rooms')
  const calls: { path: string; method: string; body: unknown }[] = []
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          path: String(input),
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : null,
        })
        return Response.json({ id: 'room/a', chatId: 'new-chat', myRole: 'owner' })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  try {
    const share = {
      description: true,
      personality: false,
      scenario: false,
      exampleDialogue: false,
      sprites: true,
      voice: false,
      lorebook: true,
    }
    await roomsApi.propose({ id: 'room/a', input: { characterId: 'mine', share, note: 'note' } })
    await roomsApi.approve({ id: 'room/a', proposalId: 'proposal/b' })
    await roomsApi.withdraw({ id: 'room/a', copyId: 'copy/c' })
    await roomsApi.notify({ id: 'room/a', preference: 'mentions' })
    await roomsApi.rsvp({ id: 'room/a', sessionId: 'session/d', response: 'maybe' })
    await roomsApi.offerTransfer({ id: 'room/a', userId: 'bob' })
    expect(calls.map((c) => [c.path, c.method])).toEqual([
      ['/api/rooms/room%2Fa/characters/proposals', 'POST'],
      ['/api/rooms/room%2Fa/characters/proposals/proposal%2Fb/approve', 'POST'],
      ['/api/rooms/room%2Fa/characters/copy%2Fc', 'DELETE'],
      ['/api/rooms/room%2Fa/notify', 'PUT'],
      ['/api/rooms/room%2Fa/sessions/session%2Fd/rsvp', 'PUT'],
      ['/api/rooms/room%2Fa/transfer', 'POST'],
    ])
    expect(calls[0]?.body).toEqual({ characterId: 'mine', share, note: 'note' })
    expect(calls[3]?.body).toEqual({ preference: 'mentions' })
    expect(calls[4]?.body).toEqual({ response: 'maybe' })
    await roomsApi.acceptTransfer('room/a')
    expect(calls.at(-1)?.path).toBe('/api/rooms/room%2Fa/transfer/accept')
  } finally {
    fetchSpy.mockRestore()
  }
})

test('MP4 被移出房间时清除提案、未读、排期与转让缓存', () => {
  const room = { id: 'room-a', chatId: 'chat-a' } as RoomDTO
  queryClient.setQueryData(roomKeys.detail('room-a'), room)
  for (const key of [
    roomKeys.proposals('room-a'),
    roomKeys.sessions('room-a'),
    roomKeys.unread('room-a'),
    roomKeys.transfer('room-a'),
  ])
    queryClient.setQueryData(key, { private: true })
  applyRoomLive('room.removed', { roomId: 'room-a' })
  for (const key of [
    roomKeys.proposals('room-a'),
    roomKeys.sessions('room-a'),
    roomKeys.unread('room-a'),
    roomKeys.transfer('room-a'),
  ])
    expect(queryClient.getQueryData(key)).toBeUndefined()
})

test('MP4 导出下载使用附件 Blob、明确扩展名并释放对象 URL', async () => {
  const { roomsApi } = await import('./rooms')
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  let clicked = false
  let removed = false
  const link = {
    href: '',
    download: '',
    click: () => {
      clicked = true
    },
    remove: () => {
      removed = true
    },
  }
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => link, body: { append: () => {} } },
  })
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => new Response('exported history'), { preconnect: fetch.preconnect }),
  )
  const create = spyOn(URL, 'createObjectURL').mockReturnValue('blob:mp4-export')
  const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  try {
    await roomsApi.export({ id: 'room-a', format: 'markdown' })
    expect(link.href).toBe('blob:mp4-export')
    expect(link.download).toBe('room-room-a.md')
    expect(clicked).toBe(true)
    expect(removed).toBe(true)
    await Bun.sleep(5)
    expect(revoke).toHaveBeenCalledWith('blob:mp4-export')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/rooms/room-a/export?format=markdown')
  } finally {
    fetchMock.mockRestore()
    create.mockRestore()
    revoke.mockRestore()
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})

test('MP4 转让换聊天 ID 后撤销旧会话的 room scope', () => {
  setRoomScope({ id: 'room-a', chatId: 'old-chat', myRole: 'owner' })
  setRoomScope({ id: 'room-a', chatId: 'new-chat', myRole: 'gm' })
  expect(scopedApiPath('/api/chats/old-chat')).toBe('/api/chats/old-chat')
  expect(scopedApiPath('/api/chats/new-chat')).toBe('/api/rooms/room-a/scope/chats/new-chat')
})

test('接受转让在发布新聊天前登记 scope，取消旧聊天请求并移除相关缓存', async () => {
  const { roomsApi } = await import('./rooms')
  const { apiFetch } = await import('./fetch')
  const room = { id: 'transfer-room', chatId: 'old-chat', myRole: 'player', myUserId: 'bob' } as RoomDTO
  const moved = { ...room, chatId: 'new-chat', myRole: 'owner', hostUserId: 'bob' } as RoomDTO
  setRoomScope(room)
  queryClient.setQueryData(roomKeys.detail(room.id), room)
  queryClient.setQueryData(roomKeys.list, [room])
  queryClient.setQueryData(['vn-stage', room.chatId], { old: true })
  queryClient.setQueryData(keys.chat('unrelated-chat'), { keep: true })
  let aborted = false
  const pending = queryClient
    .fetchQuery({
      queryKey: keys.chat(room.chatId),
      queryFn: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('cancelled'))
          })
        }),
    })
    .catch(() => undefined)
  const paths: string[] = []
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL) => {
        paths.push(String(input))
        return Response.json(String(input).endsWith('/transfer/accept') ? moved : { messages: [] })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  let publishedWithScope = false
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (
      event.query.queryKey.join('/') === roomKeys.detail(room.id).join('/') &&
      queryClient.getQueryData<RoomDTO>(roomKeys.detail(room.id))?.chatId === moved.chatId
    ) {
      publishedWithScope = scopeForChat('new-chat') === 'transfer-room'
    }
  })
  try {
    expect(await roomsApi.acceptTransfer(room.id)).toEqual(moved)
    await pending
    expect(aborted).toBe(true)
    expect(publishedWithScope).toBe(true)
    expect(queryClient.getQueryState(keys.chat(room.chatId))).toBeUndefined()
    expect(queryClient.getQueryData(['vn-stage', room.chatId])).toBeUndefined()
    expect(queryClient.getQueryData(keys.chat('unrelated-chat'))).toEqual({ keep: true })
    expect(queryClient.getQueryData(roomKeys.list)).toEqual([moved])
    await apiFetch('/api/chats/new-chat')
    // 新房主保留个人管理 API；生成等房间动作仍通过已经登记的 scope。
    expect(paths.at(-1)).toBe('/api/chats/new-chat')
    expect(scopedApiPath('/api/chats/new-chat/generate')).toBe('/api/rooms/transfer-room/scope/chats/new-chat/generate')
    expect(scopedApiPath('/api/chats/old-chat')).toBe('/api/chats/old-chat')
  } finally {
    unsubscribe()
    fetchSpy.mockRestore()
  }
})

test('旧房主收到转让事件立即切换 scope，旧私人聊天不再重取房间数据', async () => {
  const { roomsApi } = await import('./rooms')
  const { apiFetch } = await import('./fetch')
  const room = { id: 'transfer-room', chatId: 'old-chat', myRole: 'owner', myUserId: 'alice' } as RoomDTO
  const moved = { ...room, chatId: 'new-chat', myRole: 'gm', hostUserId: 'bob' } as RoomDTO
  setRoomScope(room)
  queryClient.setQueryData(roomKeys.detail(room.id), room)
  queryClient.setQueryData(roomKeys.list, [room])
  queryClient.setQueryData(keys.chat(room.chatId), { old: true })
  const paths: string[] = []
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL) => {
        paths.push(String(input))
        return Response.json(String(input) === '/api/rooms/transfer-room' ? moved : { messages: [] })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  try {
    applyRoomLive('room.transferred', { roomId: room.id, payload: { chatId: 'new-chat', hostUserId: 'bob' } })
    expect(queryClient.getQueryState(keys.chat(room.chatId))).toBeUndefined()
    expect(queryClient.getQueryData(roomKeys.detail(room.id))).toEqual(moved)
    expect(queryClient.getQueryData(roomKeys.list)).toEqual([moved])
    await apiFetch('/api/chats/old-chat')
    await apiFetch('/api/chats/new-chat')
    expect(paths).toEqual(['/api/chats/old-chat', '/api/rooms/transfer-room/scope/chats/new-chat'])
    // 详情刷新也必须在返回前登记 scope，不能依赖组件的 effect。
    removeRoomScope()
    await roomsApi.detail(room.id)
    expect(scopedApiPath('/api/chats/new-chat')).toBe('/api/rooms/transfer-room/scope/chats/new-chat')
  } finally {
    fetchSpy.mockRestore()
  }
})
