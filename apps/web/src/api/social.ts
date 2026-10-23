import type { FriendsDTO, NotificationPage, PublicUserDTO } from '@nobot/shared'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { readError } from './client'
import { apiFetch } from './fetch'

export const socialKeys = {
  all: ['social'] as const,
  friends: ['social', 'friends'] as const,
  blocks: ['social', 'blocks'] as const,
  notifications: ['social', 'notifications'] as const,
  unread: ['social', 'unread'] as const,
  lookup: (handle: string) => ['social', 'lookup', handle] as const,
}
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await apiFetch(`/api/social${path}`, {
    method,
    credentials: 'include',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (!response.ok) throw await readError(response)
  return response.json() as Promise<T>
}
export const socialApi = {
  lookup: (handle: string) => request<PublicUserDTO | null>(`/users/lookup?handle=${encodeURIComponent(handle)}`),
  friends: () => request<FriendsDTO>('/friends'),
  requestFriend: (handle: string) => request('/friends/requests', 'POST', { handle }),
  respond: ({ userId, action }: { userId: string; action: 'accept' | 'reject' | 'cancel' }) =>
    request(`/friends/requests/${encodeURIComponent(userId)}/${action}`, 'POST'),
  removeFriend: (id: string) => request(`/friends/${encodeURIComponent(id)}`, 'DELETE'),
  blocks: () => request<PublicUserDTO[]>('/blocks'),
  block: (userId: string) => request('/blocks', 'POST', { userId }),
  unblock: (id: string) => request(`/blocks/${encodeURIComponent(id)}`, 'DELETE'),
  notifications: (before?: string, limit = 50) =>
    request<NotificationPage>(`/notifications?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`),
  unread: () => request<{ unreadCount: number }>('/notifications/unread-count'),
  read: (ids?: string[]) => request('/notifications/read', 'POST', { ids }),
  dismiss: (id: string) => request(`/notifications/${encodeURIComponent(id)}/dismiss`, 'POST'),
  presence: (status: 'auto' | 'dnd' | 'invisible') => request('/presence', 'PUT', { status }),
}
export const useUserLookup = (handle: string) =>
  useQuery({
    queryKey: socialKeys.lookup(handle),
    queryFn: () => socialApi.lookup(handle),
    enabled: handle.trim().length > 0,
  })
export const useFriends = () => useQuery({ queryKey: socialKeys.friends, queryFn: socialApi.friends })
export const useBlocks = () => useQuery({ queryKey: socialKeys.blocks, queryFn: socialApi.blocks })
export const useUnreadNotifications = () => useQuery({ queryKey: socialKeys.unread, queryFn: socialApi.unread })
export const useNotifications = () =>
  useInfiniteQuery({
    queryKey: socialKeys.notifications,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => socialApi.notifications(pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })
function useSocialMutation<T, R>(fn: (input: T) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: socialKeys.all }) })
}
export const useRequestFriend = () => useSocialMutation(socialApi.requestFriend)
export const useRespondFriend = () => useSocialMutation(socialApi.respond)
export const useRemoveFriend = () => useSocialMutation(socialApi.removeFriend)
export const useBlockUser = () => useSocialMutation(socialApi.block)
export const useUnblockUser = () => useSocialMutation(socialApi.unblock)
export const useReadNotifications = () => useSocialMutation(socialApi.read)
export const useDismissNotification = () => useSocialMutation(socialApi.dismiss)
export const usePresencePreference = () => useSocialMutation(socialApi.presence)
