import type {
  ChatPage,
  CheckResult,
  ChoiceCheckInput,
  CreateRoomInput,
  MessageDTO,
  NotificationDTO,
  RollVisibility,
  RoomCharacterProposalDTO,
  RoomCharacterProposalInput,
  RoomChoiceState,
  RoomDTO,
  RoomEvent,
  RoomInitiativeInput,
  RoomInitiativeState,
  RoomInviteDTO,
  RoomInviteInput,
  RoomJoinInput,
  RoomLobbyDTO,
  RoomPersonaInput,
  RoomRole,
  RoomRollInput,
  RoomRoundState,
  RoomSendInput,
  RoomSessionDTO,
  RoomSessionInput,
  RoomTransferDTO,
  RoomUnreadDTO,
  RoomWhisperInput,
  UpdateRoomInput,
} from '@nobot/shared'
import { type InfiniteData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { t } from '../i18n'
import { useRoomLive } from '../stores/room'
import { useStreaming } from '../stores/streaming'
import { useUi } from '../stores/ui'
import { readError } from './client'
import { apiFetch } from './fetch'
import { applyNewMessage, keys, markIdle, replaceMessage } from './queries'
import { queryClient } from './queryClient'
import { removeRoomScope, scopeForChat, scopeRoomData, setRoomScope } from './room-scope'

export const roomKeys = {
  all: ['rooms'] as const,
  list: ['rooms', 'list'] as const,
  detail: (id: string) => ['rooms', 'detail', id] as const,
  lobby: (invite: string) => ['rooms', 'lobby', invite] as const,
  invites: (id: string) => ['rooms', 'invites', id] as const,
  proposals: (id: string) => ['rooms', 'proposals', id] as const,
  sessions: (id: string) => ['rooms', 'sessions', id] as const,
  unread: (id: string) => ['rooms', 'unread', id] as const,
  transfer: (id: string) => ['rooms', 'transfer', id] as const,
  usage: (id: string) => ['rooms', 'usage', id] as const,
}
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await apiFetch(`/api/rooms${path}`, {
    method,
    credentials: 'include',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (!res.ok) throw await readError(res)
  return res.json() as Promise<T>
}
/** 先切换路由并清除旧请求，再向订阅者发布新聊天 ID，避免渲染期间发出无作用域请求。 */
function registerRoom(room: RoomDTO) {
  const previous =
    queryClient.getQueryData<RoomDTO>(roomKeys.detail(room.id)) ??
    queryClient.getQueryData<RoomDTO[]>(roomKeys.list)?.find((r) => r.id === room.id)
  const oldIds = new Set(setRoomScope(room))
  if (previous && previous.chatId !== room.chatId) oldIds.add(previous.chatId)
  // 正开着旧会话的人先切到新会话，否则删掉旧查询后视图会立刻按旧 id 无作用域重新请求
  const ui = useUi.getState()
  if (ui.chatId && oldIds.has(ui.chatId) && ui.chatId !== room.chatId) ui.openChat({}, room.chatId)
  for (const chatId of oldIds) {
    const filters = { predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[1] === chatId }
    void queryClient.cancelQueries(filters)
    queryClient.removeQueries(filters)
    useStreaming.getState().end(chatId)
    deltaIndexes.delete(chatId)
  }
  return room
}
function publishRoom(room: RoomDTO) {
  registerRoom(room)
  queryClient.setQueryData(roomKeys.detail(room.id), room)
  queryClient.setQueryData<RoomDTO[]>(roomKeys.list, (old) => old?.map((r) => (r.id === room.id ? room : r)))
  return room
}
const enc = encodeURIComponent
export const roomsApi = {
  proposals: (id: string) => request<RoomCharacterProposalDTO[]>(`/${enc(id)}/characters/proposals`),
  proposal: (id: string, proposalId: string) =>
    request<RoomCharacterProposalDTO>(`/${enc(id)}/characters/proposals/${enc(proposalId)}`),
  propose: ({ id, input }: { id: string; input: RoomCharacterProposalInput }) =>
    request<RoomCharacterProposalDTO>(`/${enc(id)}/characters/proposals`, 'POST', input),
  approve: ({ id, proposalId }: { id: string; proposalId: string }) =>
    request<RoomCharacterProposalDTO>(`/${enc(id)}/characters/proposals/${enc(proposalId)}/approve`, 'POST'),
  reject: ({ id, proposalId }: { id: string; proposalId: string }) =>
    request<RoomCharacterProposalDTO>(`/${enc(id)}/characters/proposals/${enc(proposalId)}/reject`, 'POST'),
  withdraw: ({ id, copyId }: { id: string; copyId: string }) =>
    request(`/${enc(id)}/characters/${enc(copyId)}`, 'DELETE'),
  unread: (id: string) => request<RoomUnreadDTO>(`/${enc(id)}/unread`),
  notify: ({ id, preference }: { id: string; preference: 'all' | 'mentions' | 'none' }) =>
    request(`/${enc(id)}/notify`, 'PUT', { preference }),
  sessions: (id: string) => request<RoomSessionDTO[]>(`/${enc(id)}/sessions`),
  createSession: ({ id, input }: { id: string; input: RoomSessionInput }) =>
    request<RoomSessionDTO>(`/${enc(id)}/sessions`, 'POST', input),
  updateSession: ({ id, sessionId, input }: { id: string; sessionId: string; input: RoomSessionInput }) =>
    request<RoomSessionDTO>(`/${enc(id)}/sessions/${enc(sessionId)}`, 'PUT', input),
  cancelSession: ({ id, sessionId }: { id: string; sessionId: string }) =>
    request(`/${enc(id)}/sessions/${enc(sessionId)}`, 'DELETE'),
  rsvp: ({ id, sessionId, response }: { id: string; sessionId: string; response: 'yes' | 'maybe' | 'no' }) =>
    request(`/${enc(id)}/sessions/${enc(sessionId)}/rsvp`, 'PUT', { response }),
  transfer: (id: string) => request<RoomTransferDTO | null>(`/${enc(id)}/transfer`),
  offerTransfer: ({ id, userId }: { id: string; userId: string }) =>
    request<RoomTransferDTO>(`/${enc(id)}/transfer`, 'POST', { userId }),
  acceptTransfer: async (id: string) => publishRoom(await request<RoomDTO>(`/${enc(id)}/transfer/accept`, 'POST')),
  declineTransfer: (id: string) => request(`/${enc(id)}/transfer/decline`, 'POST'),
  export: async ({ id, format }: { id: string; format: 'markdown' | 'json' }) => {
    const response = await apiFetch(`/api/rooms/${enc(id)}/export?format=${format}`, { credentials: 'include' })
    if (!response.ok) throw await readError(response)
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `room-${id}.${format === 'json' ? 'json' : 'md'}`
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  },
  list: async () => {
    const rooms = await request<RoomDTO[]>('')
    for (const room of rooms) {
      registerRoom(room)
      // 列表和详情必须同时换代，避免旧详情在下一次渲染时重新登记旧聊天。
      if (queryClient.getQueryData(roomKeys.detail(room.id))) queryClient.setQueryData(roomKeys.detail(room.id), room)
    }
    return rooms
  },
  detail: async (id: string) => publishRoom(await request<RoomDTO>(`/${enc(id)}`)),
  create: (input: CreateRoomInput) => request<RoomDTO>('', 'POST', input),
  update: ({ id, input }: { id: string; input: UpdateRoomInput }) => request<RoomDTO>(`/${enc(id)}`, 'PATCH', input),
  remove: (id: string) => request(`/${enc(id)}`, 'DELETE'),
  lobby: (invite: string) => request<RoomLobbyDTO>(`/lobby?invite=${enc(invite)}`),
  join: (input: RoomJoinInput) => request<RoomDTO>('/join', 'POST', input),
  invites: (id: string) => request<RoomInviteDTO[]>(`/${enc(id)}/invites`),
  invite: ({ id, input }: { id: string; input: RoomInviteInput }) =>
    request<RoomInviteDTO & { token?: string; url?: string }>(`/${enc(id)}/invites`, 'POST', input),
  revokeInvite: ({ id, inviteId }: { id: string; inviteId: string }) =>
    request(`/${enc(id)}/invites/${enc(inviteId)}`, 'DELETE'),
  usage: (id: string) =>
    request<{ id: string; userId: string; kind: 'text' | 'image' | 'tts'; tokens: number | null; createdAt: number }[]>(
      `/${enc(id)}/usage`,
    ),
  leave: (id: string) => request(`/${enc(id)}/leave`, 'POST'),
  kick: ({ id, userId }: { id: string; userId: string }) => request(`/${enc(id)}/members/${enc(userId)}/kick`, 'POST'),
  ban: ({ id, userId }: { id: string; userId: string }) => request(`/${enc(id)}/members/${enc(userId)}/ban`, 'POST'),
  unban: ({ id, userId }: { id: string; userId: string }) => request(`/${enc(id)}/bans/${enc(userId)}`, 'DELETE'),
  role: ({ id, userId, role }: { id: string; userId: string; role: Exclude<RoomRole, 'owner'> }) =>
    request<RoomDTO>(`/${enc(id)}/members/${enc(userId)}/role`, 'PATCH', { role }),
  persona: ({ id, ...input }: RoomPersonaInput & { id: string }) =>
    request<RoomDTO>(`/${enc(id)}/persona`, 'PUT', input),
  acceptRules: ({ id, rulesVersion }: { id: string; rulesVersion: number }) =>
    request<RoomDTO>(`/${enc(id)}/accept-rules`, 'POST', { rulesVersion }),
  send: ({ id, input }: { id: string; input: RoomSendInput }) =>
    request<MessageDTO>(`/${enc(id)}/messages`, 'POST', input),
  edit: ({ id, messageId, content }: { id: string; messageId: string; content: string }) =>
    request<MessageDTO>(`/${enc(id)}/messages/${enc(messageId)}`, 'PATCH', { content }),
  deleteMessage: ({ id, messageId }: { id: string; messageId: string }) =>
    request<MessageDTO>(`/${enc(id)}/messages/${enc(messageId)}`, 'DELETE'),
  turn: (id: string) => request(`/${enc(id)}/turn`, 'POST'),
  abort: (id: string) => request(`/${enc(id)}/abort`, 'POST'),
  requestTurn: (id: string) => request(`/${enc(id)}/turn/request`, 'POST'),
  suggest: ({ id, messageId }: { id: string; messageId: string }) =>
    request(`/${enc(id)}/messages/${enc(messageId)}/suggest`, 'POST'),
  read: ({ id, seq }: { id: string; seq: number }) => request(`/${enc(id)}/read`, 'POST', { seq }),
  typing: (id: string) => request(`/${enc(id)}/typing`, 'POST'),
  roll: (id: string, input: RoomRollInput) =>
    request<{ result: string; message: MessageDTO }>(`/${enc(id)}/roll`, 'POST', input),
  check: ({
    id,
    chatId,
    input,
  }: {
    id: string
    chatId: string
    input: ChoiceCheckInput & { visibility?: RollVisibility }
  }) => request<CheckResult | { hidden: true }>(`/${enc(id)}/scope/chats/${enc(chatId)}/check`, 'POST', input),
  whisper: ({ id, input }: { id: string; input: RoomWhisperInput }) =>
    request<MessageDTO>(`/${enc(id)}/whispers`, 'POST', input),
  ready: ({ id, state }: { id: string; state: 'done' | 'passed' | 'pending' }) =>
    request<RoomRoundState>(`/${enc(id)}/round/ready`, 'POST', { state }),
  skipRound: ({ id, userId }: { id: string; userId: string }) =>
    request<RoomRoundState>(`/${enc(id)}/round/skip`, 'POST', { userId }),
  nextRound: (id: string) => request<RoomRoundState>(`/${enc(id)}/round/next`, 'POST'),
  initiative: (id: string) => request<RoomInitiativeState>(`/${enc(id)}/initiative`),
  setInitiative: ({ id, input }: { id: string; input: RoomInitiativeInput }) =>
    request<RoomInitiativeState>(`/${enc(id)}/initiative`, 'PUT', input),
  skipInitiative: (id: string) => request<RoomInitiativeState>(`/${enc(id)}/initiative/skip`, 'POST'),
  choice: (id: string, messageId: string) => request<RoomChoiceState>(`/${enc(id)}/choices/${enc(messageId)}`),
  vote: ({ id, messageId, index }: { id: string; messageId: string; index: number }) =>
    request<RoomChoiceState | MessageDTO>(`/${enc(id)}/choices/${enc(messageId)}/vote`, 'POST', { index }),
  closeChoice: ({ id, messageId, winner }: { id: string; messageId: string; winner?: number }) =>
    request<RoomChoiceState>(`/${enc(id)}/choices/${enc(messageId)}/close`, 'POST', { winner }),
}
export function useRooms() {
  const query = useQuery({ queryKey: roomKeys.list, queryFn: roomsApi.list })
  for (const room of query.data ?? []) setRoomScope(room)
  return query
}
export const useRoom = (id: string | null) =>
  useQuery({ queryKey: roomKeys.detail(id ?? ''), queryFn: () => roomsApi.detail(id!), enabled: !!id })
export const useRoomLobby = (invite: string | null) =>
  useQuery({
    queryKey: roomKeys.lobby(invite ?? ''),
    queryFn: () => roomsApi.lobby(invite!),
    enabled: !!invite,
    retry: false,
  })
export const useRoomInvites = (id: string) =>
  useQuery({ queryKey: roomKeys.invites(id), queryFn: () => roomsApi.invites(id) })
export const useRoomUsage = (id: string) =>
  useQuery({ queryKey: roomKeys.usage(id), queryFn: () => roomsApi.usage(id) })
function useRoomMutation<T, R>(fn: (input: T) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: roomKeys.all }) })
}
export const useCreateRoom = () => useRoomMutation(roomsApi.create)
export const useUpdateRoom = () => useRoomMutation(roomsApi.update)
export const useDeleteRoom = () => useRoomMutation(roomsApi.remove)
export const useJoinRoom = () => useRoomMutation(roomsApi.join)
export const useCreateRoomInvite = () => useRoomMutation(roomsApi.invite)
export const useRevokeRoomInvite = () => useRoomMutation(roomsApi.revokeInvite)
export const useLeaveRoom = () => useRoomMutation(roomsApi.leave)
export const useKickRoomMember = () => useRoomMutation(roomsApi.kick)
export const useBanRoomMember = () => useRoomMutation(roomsApi.ban)
export const useUnbanRoomMember = () => useRoomMutation(roomsApi.unban)
export const useRoomRole = () => useRoomMutation(roomsApi.role)
export const useRoomPersona = () => useRoomMutation(roomsApi.persona)
export const useAcceptRoomRules = () => useRoomMutation(roomsApi.acceptRules)
function useRoomMessageMutation<T extends { id: string }>(fn: (input: T) => Promise<MessageDTO>) {
  return useMutation({
    mutationFn: fn,
    onSuccess: (message, { id }) => mergeMessage(scopeRoomData(message, id)),
  })
}
export const useEditRoomMessage = () => useRoomMessageMutation(roomsApi.edit)
export const useDeleteRoomMessage = () => useRoomMessageMutation(roomsApi.deleteMessage)
export const useTriggerRoomTurn = () => useRoomMutation(roomsApi.turn)
export const useAbortRoomTurn = () => useRoomMutation(roomsApi.abort)
export const useRequestRoomTurn = () => useRoomMutation(roomsApi.requestTurn)
export const useSuggestRegenerate = () => useRoomMutation(roomsApi.suggest)
export const useReadRoom = () => useRoomMutation(roomsApi.read)
export function clientMessageId() {
  return crypto.randomUUID()
}
export function useSendRoomMessage() {
  return useMutation({
    mutationFn: roomsApi.send,
    onMutate: ({ id, input }) => {
      const room =
        queryClient.getQueryData<RoomDTO>(roomKeys.detail(id)) ??
        queryClient.getQueryData<RoomDTO[]>(roomKeys.list)?.find((r) => r.id === id)
      if (!room) return
      const cache = queryClient.getQueryData<InfiniteData<ChatPage>>(keys.chat(room.chatId))
      const member = room.members.find((m) => m.userId === room.myUserId)
      const optimistic: MessageDTO = {
        id: `optimistic:${input.clientMessageId}`,
        chatId: room.chatId,
        parentId: cache?.pages[0]?.messages.at(-1)?.id ?? null,
        role: 'user',
        content: input.text,
        status: 'done',
        createdAt: Date.now(),
        speakerId: null,
        swipeIndex: 1,
        swipeCount: 1,
        meta: {
          clientMessageId: input.clientMessageId,
          channel: input.channel,
          excluded: input.channel === 'ooc',
          name: member?.personaName,
        },
      }
      applyNewMessage(queryClient, room.chatId, optimistic)
      return { chatId: room.chatId, messageId: optimistic.id }
    },
    onSuccess: (message, { id }) => mergeMessage(scopeRoomData(message, id)),
    onError: (_error, _input, context) => {
      if (context)
        queryClient.setQueryData<InfiniteData<ChatPage>>(keys.chat(context.chatId), (old) =>
          old
            ? {
                ...old,
                pages: old.pages.map((p) => ({ ...p, messages: p.messages.filter((m) => m.id !== context.messageId) })),
              }
            : old,
        )
    },
  })
}
export function mergeMessage(message: MessageDTO) {
  // 先替换再插入；事件与 HTTP 响应先后顺序都不会产生重复消息。
  const cache = queryClient.getQueryData<InfiniteData<ChatPage>>(keys.chat(message.chatId))
  if (cache?.pages.some((p) => p.messages.some((m) => m.id === message.id)))
    replaceMessage(queryClient, message.chatId, message)
  else {
    queryClient.setQueryData<InfiniteData<ChatPage>>(keys.chat(message.chatId), (old) =>
      old
        ? {
            ...old,
            pages: old.pages.map((p) => ({
              ...p,
              messages: p.messages.filter(
                (m) => !(m.id.startsWith('optimistic:') && m.meta.clientMessageId === message.meta.clientMessageId),
              ),
            })),
          }
        : old,
    )
    if (!applyNewMessage(queryClient, message.chatId, message))
      void queryClient.invalidateQueries({ queryKey: keys.chat(message.chatId) })
  }
}
export function useRoomForChat(chatId: string | null) {
  const list = useRooms()
  const summary = list.data?.find((r) => r.chatId === chatId)
  const detail = useRoom(summary?.id ?? null)
  const room = detail.data ?? summary
  if (room) setRoomScope(room)
  useViewRoom(room)
  return room ? { room, myRole: room.myRole, permissions: room.permissions } : undefined
}
const viewing = new Map<string, number>(),
  cursors = new Map<string, number>(),
  deltaIndexes = new Map<string, number>()
let connectionId: string | undefined
async function topic(id: string, unsubscribe = false) {
  if (!connectionId) return
  await apiFetch('/api/live/topics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectionId, topic: `room:${id}`, since: cursors.get(id) ?? 0, unsubscribe }),
  })
}
export function roomLiveConnected(id: string) {
  connectionId = id
  for (const room of viewing.keys()) void topic(room)
}
export function viewRoom(room: RoomDTO) {
  setRoomScope(room)
  void queryClient.invalidateQueries({ queryKey: keys.chat(room.chatId) })
  viewing.set(room.id, (viewing.get(room.id) ?? 0) + 1)
  void topic(room.id)
  return () => {
    const n = (viewing.get(room.id) ?? 1) - 1
    if (n) viewing.set(room.id, n)
    else {
      viewing.delete(room.id)
      void topic(room.id, true)
      removeRoomScope(room.chatId)
    }
  }
}
export function useViewRoom(room: RoomDTO | undefined) {
  useEffect(() => (room ? viewRoom(room) : undefined), [room?.id, room?.chatId])
}
const typingAt = new Map<string, number>()
export function reportRoomTyping(id: string) {
  if (Date.now() - (typingAt.get(id) ?? 0) < 1000) return
  const room = queryClient.getQueryData<RoomDTO>(roomKeys.detail(id))
  if (room?.permissions.isSpectator) return
  typingAt.set(id, Date.now())
  void roomsApi.typing(id).catch(() => {})
}
export function roomInviteDestination(notification: NotificationDTO) {
  return notification.type === 'room.invite' && typeof notification.payload.inviteId === 'string'
    ? { invite: notification.payload.inviteId, path: `/join/${enc(notification.payload.inviteId)}` }
    : null
}
export function joinInviteFromPath(path = globalThis.location?.pathname ?? '') {
  const match = /^\/join\/([^/]+)\/?$/.exec(path)
  return match ? decodeURIComponent(match[1]!) : null
}
export const useJoinLobby = () => useRoomLobby(joinInviteFromPath())
export function applyRoomLive(type: string, raw: unknown) {
  if (!raw || typeof raw !== 'object' || !('roomId' in raw) || typeof raw.roomId !== 'string') return
  const id = raw.roomId
  const room =
    queryClient.getQueryData<RoomDTO>(roomKeys.detail(id)) ??
    queryClient.getQueryData<RoomDTO[]>(roomKeys.list)?.find((r) => r.id === id)
  if (type === 'room.removed') {
    if (room) {
      removeRoomScope(room.chatId)
      queryClient.removeQueries({ queryKey: keys.chat(room.chatId) })
      queryClient.removeQueries({ queryKey: ['vn-stage', room.chatId] })
      queryClient.removeQueries({ queryKey: roomKeys.invites(id) })
      queryClient.removeQueries({ queryKey: roomKeys.usage(id) })
      useStreaming.getState().end(room.chatId)
    }
    for (const key of [roomKeys.proposals(id), roomKeys.sessions(id), roomKeys.unread(id), roomKeys.transfer(id)])
      queryClient.removeQueries({ queryKey: key })
    queryClient.setQueryData<RoomDTO[]>(roomKeys.list, (old) => old?.filter((r) => r.id !== id))
    useRoomLive.getState().clearRoom(id)
    viewing.delete(id)
    cursors.delete(id)
    queryClient.removeQueries({ queryKey: roomKeys.detail(id) })
    void queryClient.invalidateQueries({ queryKey: roomKeys.list })
    return
  }
  const event = raw as RoomEvent
  if (type === 'room.resync') {
    cursors.set(id, event.seq ?? 0)
    if (room) void queryClient.invalidateQueries({ queryKey: keys.chat(room.chatId) })
    return
  }
  if (event.seq) {
    if (event.seq <= (cursors.get(id) ?? 0)) return
    cursors.set(id, event.seq)
  }
  const p = event.payload ?? {}
  if (type === 'room.initiative') void queryClient.invalidateQueries({ queryKey: roomKeys.detail(id) })
  if (type === 'room.round' || type === 'room.initiative') {
    const field = type === 'room.round' ? 'round' : 'initiative'
    queryClient.setQueryData<RoomDTO>(roomKeys.detail(id), (old) => (old ? { ...old, [field]: p } : old))
    queryClient.setQueryData<RoomDTO[]>(roomKeys.list, (old) =>
      old?.map((r) => (r.id === id ? { ...r, [field]: p } : r)),
    )
  }
  if (type === 'room.choice' && typeof p.messageId === 'string')
    queryClient.setQueryData(['rooms', 'choice', id, p.messageId], p)
  if (type === 'room.typing' && typeof p.userId === 'string' && typeof p.expiresAt === 'number')
    useRoomLive.getState().setTyping(id, p.userId, p.expiresAt)
  if (type === 'room.turn') useRoomLive.setState((s) => ({ turns: { ...s.turns, [id]: p } }))
  if (type === 'room.suggestion' && typeof p.messageId === 'string' && typeof p.userId === 'string') {
    const messageId = p.messageId,
      userId = p.userId
    useRoomLive.setState((s) => ({
      suggestions: {
        ...s.suggestions,
        [id]: { ...s.suggestions[id], [messageId]: [...new Set([...(s.suggestions[id]?.[messageId] ?? []), userId])] },
      },
    }))
  }
  if (type === 'room.message' && p.action === 'activated' && room)
    void queryClient.invalidateQueries({ queryKey: keys.chat(room.chatId) })
  if (type === 'room.message' && p.message) mergeMessage(scopeRoomData(p.message as MessageDTO, id))
  if (type === 'room.generation' && room) {
    const stream = useStreaming.getState()
    if (p.type === 'start' && p.assistantMessage) {
      const m = scopeRoomData(p.assistantMessage as MessageDTO, id)
      mergeMessage(m)
      stream.begin(room.chatId, m.id, m.content)
      deltaIndexes.set(room.chatId, -1)
    }
    if (p.type === 'delta' && typeof p.text === 'string') {
      const active = stream.streams[room.chatId]
      if (active && (!p.messageId || p.messageId === active.messageId)) {
        if (typeof p.index !== 'number' || p.index > (deltaIndexes.get(room.chatId) ?? -1)) {
          stream.append(p.text, typeof p.reasoning === 'string' ? p.reasoning : '', room.chatId)
          if (typeof p.index === 'number') deltaIndexes.set(room.chatId, p.index)
        }
      }
    }
    if ((p.type === 'done' || p.type === 'message') && p.message) {
      mergeMessage(scopeRoomData(p.message as MessageDTO, id))
      if (p.type === 'done') stream.end(room.chatId)
    }
    if (p.type === 'complete') {
      stream.end(room.chatId)
      markIdle(queryClient, room.chatId)
      void queryClient.invalidateQueries({ queryKey: keys.chat(room.chatId) })
    }
    if (p.type === 'error' && typeof p.message === 'string') {
      const error = p.message
      useRoomLive.setState((s) => ({ turns: { ...s.turns, [id]: { ...s.turns[id], error } } }))
    }
  }
  if (type === 'room.resync' && room) void queryClient.invalidateQueries({ queryKey: keys.chat(room.chatId) })
  if (type.startsWith('room.character.') || type === 'room.session' || type === 'room.transferred') {
    if (type === 'room.transferred' && room) {
      if (typeof p.chatId === 'string' && typeof p.hostUserId === 'string') {
        publishRoom({
          ...room,
          chatId: p.chatId,
          hostUserId: p.hostUserId,
          myRole: room.myUserId === p.hostUserId ? 'owner' : room.myRole === 'owner' ? 'gm' : room.myRole,
        })
      }
    }
    if (room && type !== 'room.transferred') void queryClient.invalidateQueries({ queryKey: keys.chat(room.chatId) })
    void queryClient.invalidateQueries({ queryKey: roomKeys.all })
  }
  if (type === 'room.member' || type === 'room.settings')
    void queryClient.invalidateQueries({ queryKey: roomKeys.detail(id) })
  // 设置变化可能改变能看到的历史（比如旁观者改成看全部公开历史），重新拉会话
  if (type === 'room.settings' && room) void queryClient.invalidateQueries({ queryKey: keys.chat(room.chatId) })
  if (event.seq) {
    if (viewing.has(id)) void roomsApi.read({ id, seq: event.seq }).catch(() => {})
    void queryClient.invalidateQueries({ queryKey: roomKeys.list })
    void queryClient.invalidateQueries({ queryKey: roomKeys.unread(id) })
  }
}
export function clearRoomSession() {
  connectionId = undefined
  viewing.clear()
  cursors.clear()
  deltaIndexes.clear()
  typingAt.clear()
  removeRoomScope()
  useRoomLive.setState({ typing: {}, turns: {}, suggestions: {} })
  useStreaming.setState({ streams: {}, chatId: null, messageId: null, text: '', reasoning: '' })
  queryClient.removeQueries({ queryKey: roomKeys.all })
}
export { scopeForChat }

export const useSendWhisper = () => useRoomMessageMutation(roomsApi.whisper)
export const useRoundReady = () => useRoomMutation(roomsApi.ready)
export const useSkipRoundMember = () => useRoomMutation(roomsApi.skipRound)
export const useNextRound = () => useRoomMutation(roomsApi.nextRound)
export const useSetInitiative = () => useRoomMutation(roomsApi.setInitiative)
export const useSkipInitiative = () => useRoomMutation(roomsApi.skipInitiative)
export const useVoteChoice = () => useRoomMutation(roomsApi.vote)
export const useCloseChoice = () => useRoomMutation(roomsApi.closeChoice)
export function useRoundState(roomId: string) {
  return useRoom(roomId).data?.round
}
export function useInitiative(roomId: string) {
  return useRoom(roomId).data?.initiative
}
export function useChoiceVotes(roomId: string, messageId: string) {
  return useQuery({
    queryKey: ['rooms', 'choice', roomId, messageId],
    queryFn: () => roomsApi.choice(roomId, messageId),
    enabled: !!roomId && !!messageId,
  })
}
/** 服务端已裁剪权限，显示层只需判断占位标记。 */
export function canSeeRollResult(message: MessageDTO) {
  return !message.meta.hidden
}

export function useRoomRoll() {
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: RoomRollInput }) => roomsApi.roll(id, input),
    onSuccess: ({ message }, { id }) => mergeMessage(scopeRoomData(message, id)),
  })
}

export const useRoomCheck = () => useRoomMutation(roomsApi.check)

export const useRoomCharacterProposals = (id: string) =>
  useQuery({ queryKey: roomKeys.proposals(id), queryFn: () => roomsApi.proposals(id) })
export const useRoomCharacterProposal = (id: string, proposalId: string) =>
  useQuery({ queryKey: [...roomKeys.proposals(id), proposalId], queryFn: () => roomsApi.proposal(id, proposalId) })
export const useProposeRoomCharacter = () => useRoomMutation(roomsApi.propose)
export const useApproveRoomCharacter = () => useRoomMutation(roomsApi.approve)
export const useRejectRoomCharacter = () => useRoomMutation(roomsApi.reject)
export const useWithdrawRoomCharacter = () => useRoomMutation(roomsApi.withdraw)
export const useRoomUnread = (id: string) =>
  useQuery({ queryKey: roomKeys.unread(id), queryFn: () => roomsApi.unread(id) })
export function useRoomUnreadTarget(id: string) {
  return useRoomUnread(id).data?.firstUnreadMessageId ?? null
}
export const useRoomNotifyPreference = () => useRoomMutation(roomsApi.notify)
export const useRoomSessions = (id: string) =>
  useQuery({ queryKey: roomKeys.sessions(id), queryFn: () => roomsApi.sessions(id) })
export const useCreateRoomSession = () => useRoomMutation(roomsApi.createSession)
export const useUpdateRoomSession = () => useRoomMutation(roomsApi.updateSession)
export const useCancelRoomSession = () => useRoomMutation(roomsApi.cancelSession)
export const useRoomSessionRsvp = () => useRoomMutation(roomsApi.rsvp)
export const useRoomTransfer = (id: string) =>
  useQuery({ queryKey: roomKeys.transfer(id), queryFn: () => roomsApi.transfer(id) })
export const useOfferRoomTransfer = () => useRoomMutation(roomsApi.offerTransfer)
export const useAcceptRoomTransfer = () => useRoomMutation(roomsApi.acceptTransfer)
export const useDeclineRoomTransfer = () => useRoomMutation(roomsApi.declineTransfer)
export const useExportRoom = () => useMutation({ mutationFn: roomsApi.export })

/** 通知正文不含房间名称或内容预览，视觉层可直接展示此标签。 */
export function roomNotificationText(notification: NotificationDTO): string | null {
  switch (notification.type) {
    case 'room.character.proposed':
      return t('有新的房间角色提案')
    case 'room.character.approved':
      return t('你的房间角色提案已批准')
    case 'room.character.rejected':
      return t('你的房间角色提案已拒绝')
    case 'room.your-turn':
      return t('轮到你在房间中行动了')
    case 'room.mention':
      return t('有人在房间中提到了你')
    case 'room.session.created':
      return t('房间有新的活动排期')
    case 'room.session.starting':
      return t('你报名的房间活动即将开始')
    case 'room.transfer.offered':
      return t('你收到了一份房主转让邀请')
    default:
      return null
  }
}
