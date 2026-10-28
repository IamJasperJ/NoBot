import type {
  ChannelAccountDTO,
  ChannelAccountInput,
  ChannelActorDTO,
  ChannelBindingDTO,
  ChannelBindingInput,
  ChannelFriendDTO,
  ChannelLogEntry,
  ChannelPolicies,
  ChannelPresencePreview,
  ChannelPresenceSync,
  ChannelRequestDTO,
  ChannelSettingsResolution,
  ChannelStickerPatch,
  ChannelStickersDTO,
} from '@nobot/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { readError } from './client'
import { apiFetch } from './fetch'

export type {
  ChannelAccountDTO,
  ChannelAccountInput,
  ChannelActorDTO,
  ChannelBindingDTO,
  ChannelBindingInput,
  ChannelCapabilities,
  ChannelCapabilityState,
  ChannelFriendDTO,
  ChannelLogEntry,
  ChannelPolicies,
  ChannelPresence,
  ChannelPresencePreview,
  ChannelPresenceSync,
  ChannelPresenceValue,
  ChannelProvider,
  ChannelRequestDTO,
  ChannelSettings,
  ChannelSettingsOverride,
  ChannelSettingsResolution,
  ChannelStickerDTO,
  ChannelStickerGroupDTO,
  ChannelStickerPatch,
  ChannelStickerRef,
  ChannelStickersDTO,
} from '@nobot/shared'
export const channelKeys = {
  all: ['channels'] as const,
  stickers: (id: string) => ['channels', 'stickers', id] as const,
  accounts: ['channels', 'accounts'] as const,
  account: (id: string) => ['channels', 'account', id] as const,
  bindings: (accountId?: string) => ['channels', 'bindings', accountId ?? 'all'] as const,
  binding: (id: string) => ['channels', 'binding', id] as const,
  settings: (id: string) => ['channels', 'settings', id] as const,
  actors: ['channels', 'actors'] as const,
  requests: (accountId?: string) => ['channels', 'requests', accountId ?? 'all'] as const,
  presence: (id: string) => ['channels', 'presence', id] as const,
  log: ['channels', 'log'] as const,
  friends: (id: string) => ['channels', 'friends', id] as const,
  managedAccess: (id: string) => ['channels', 'managed-access', id] as const,
}
const encode = encodeURIComponent
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await apiFetch(`/api/ext/channels${path}`, {
    method,
    credentials: 'include',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (!response.ok) throw await readError(response)
  return response.json() as Promise<T>
}
export type ChannelNativeAction =
  | { action: 'pin' | 'unpin'; messageId: number; confirm: true }
  | { action: 'topic'; name: string; confirm: true }
  | { action: 'title'; title: string; confirm: true }
  | { action: 'description'; description: string; confirm: true }
export interface ManagedBotLinkInput {
  id: string
  characterId: string
  suggestedUsername?: string
  suggestedName?: string
}
export interface ManagedBotAccessSettings {
  is_access_restricted: boolean
  added_user_ids?: number[]
}
export type ChannelOneBotAction =
  | { action: 'essence' | 'read'; messageId: number; confirm: true }
  | { action: 'notice'; content: string; confirm: true }
export const channelsApi = {
  stickers: (id: string) => request<ChannelStickersDTO>(`/accounts/${encode(id)}/stickers`),
  addStickerSet: ({ accountId, name }: { accountId: string; name: string }) =>
    request<ChannelStickersDTO>(`/accounts/${encode(accountId)}/stickers/sets`, 'POST', { name }),
  refreshQqFaces: (accountId: string) =>
    request<ChannelStickersDTO>(`/accounts/${encode(accountId)}/stickers/refresh`, 'POST'),
  updateSticker: ({
    accountId,
    id,
    kind = 'entries',
    patch,
  }: {
    accountId: string
    id: string
    kind?: 'entries' | 'sets'
    patch: ChannelStickerPatch
  }) => request<ChannelStickersDTO>(`/accounts/${encode(accountId)}/stickers/${kind}/${encode(id)}`, 'PATCH', patch),
  deleteSticker: ({ accountId, id, kind = 'entries' }: { accountId: string; id: string; kind?: 'entries' | 'sets' }) =>
    request<ChannelStickersDTO>(`/accounts/${encode(accountId)}/stickers/${kind}/${encode(id)}`, 'DELETE'),
  friends: (id: string) => request<ChannelFriendDTO[]>(`/accounts/${encode(id)}/friends`),
  deleteFriend: ({ id, userId, confirm }: { id: string; userId: number; confirm: true }) =>
    request<{ ok: true }>(`/accounts/${encode(id)}/friends/delete`, 'POST', { userId, confirm }),
  onebot: ({ id, input }: { id: string; input: ChannelOneBotAction }) =>
    request<{ ok: true }>(`/bindings/${encode(id)}/onebot`, 'POST', input),
  stageLink: ({ id, actorId }: { id: string; actorId: string }) =>
    request<{ url: string; expiresIn: number }>(`/bindings/${encode(id)}/stage-link`, 'POST', { actorId }),
  managedBotLink: ({ id, ...input }: ManagedBotLinkInput) =>
    request<{ url: string }>(`/accounts/${encode(id)}/managed-bots/link`, 'POST', input),
  rotateManagedBotToken: (id: string) =>
    request<ChannelAccountDTO>(`/accounts/${encode(id)}/managed-bots/rotate-token`, 'POST'),
  managedBotAccess: (id: string) => request<ManagedBotAccessSettings>(`/accounts/${encode(id)}/managed-bots/access`),
  updateManagedBotAccess: ({ id, ...input }: { id: string; restricted: boolean; addedUserIds?: number[] }) =>
    request<{ ok: true }>(`/accounts/${encode(id)}/managed-bots/access`, 'PUT', input),
  accounts: () => request<ChannelAccountDTO[]>('/accounts'),
  account: (id: string) => request<ChannelAccountDTO>(`/accounts/${encode(id)}`),
  createAccount: (input: ChannelAccountInput) => request<ChannelAccountDTO>('/accounts', 'POST', input),
  updateAccount: ({
    id,
    patch,
  }: {
    id: string
    patch: Partial<Omit<ChannelAccountInput, 'credentials'>> & {
      credentials?: ChannelAccountInput['credentials'] | string
    }
  }) => request<ChannelAccountDTO>(`/accounts/${encode(id)}`, 'PATCH', patch),
  deleteAccount: (id: string) => request<{ ok: true }>(`/accounts/${encode(id)}`, 'DELETE'),
  accountAction: ({ id, action }: { id: string; action: 'start' | 'stop' | 'restart' }) =>
    request<ChannelAccountDTO>(`/accounts/${encode(id)}/${action}`, 'POST'),
  regenerateIntro: (id: string) =>
    request<ChannelPresencePreview>(`/accounts/${encode(id)}/presence/regenerate-intro`, 'POST'),
  presencePreview: (id: string) => request<ChannelPresencePreview>(`/accounts/${encode(id)}/presence/preview`),
  presenceApply: ({ id, confirm }: { id: string; confirm: true }) =>
    request<ChannelPresenceSync>(`/accounts/${encode(id)}/presence/apply`, 'POST', { confirm }),
  presenceSync: (id: string) => request<ChannelPresenceSync>(`/accounts/${encode(id)}/presence/sync`, 'POST'),
  policies: ({ id, policies, confirm }: { id: string; policies: ChannelPolicies; confirm?: boolean }) =>
    request<ChannelAccountDTO>(`/accounts/${encode(id)}/policies`, 'PUT', { policies, confirm }),
  requests: (accountId?: string) =>
    request<ChannelRequestDTO[]>(`/requests${accountId ? `?accountId=${encode(accountId)}` : ''}`),
  respondRequest: ({ id, action }: { id: string; action: 'approve' | 'reject' | 'block' }) =>
    request<{ ok: true }>(`/requests/${encode(id)}/${action}`, 'POST'),
  bindings: (accountId?: string) =>
    request<ChannelBindingDTO[]>(`/bindings${accountId ? `?accountId=${encode(accountId)}` : ''}`),
  createBinding: (input: ChannelBindingInput) => request<ChannelBindingDTO>('/bindings', 'POST', input),
  binding: (id: string) => request<ChannelBindingDTO>(`/bindings/${encode(id)}`),
  updateBinding: ({ id, patch }: { id: string; patch: Partial<ChannelBindingInput> & { voicePreference?: null } }) =>
    request<ChannelBindingDTO>(`/bindings/${encode(id)}`, 'PATCH', patch),
  disableBinding: (id: string) => request<{ ok: true }>(`/bindings/${encode(id)}/disable`, 'POST'),
  leaveBinding: ({ id, confirm }: { id: string; confirm: true }) =>
    request<{ ok: true }>(`/bindings/${encode(id)}/leave`, 'POST', { confirm }),
  settings: (id: string) => request<ChannelSettingsResolution>(`/bindings/${encode(id)}/settings`),
  actors: () => request<ChannelActorDTO[]>('/actors'),
  updateActor: ({
    id,
    patch,
  }: {
    id: string
    patch: Partial<Pick<ChannelActorDTO, 'role' | 'personaId' | 'linkedUserId' | 'personaName' | 'personaDescription'>>
  }) => request<ChannelActorDTO>(`/actors/${encode(id)}`, 'PATCH', patch),
  confirmPairing: (input: string | { code: string; ownerHandle?: string }) =>
    request<ChannelActorDTO>('/pairings/confirm', 'POST', typeof input === 'string' ? { code: input } : input),
  log: () => request<ChannelLogEntry[]>('/log'),
  testSend: ({ id, chat, text }: { id: string; chat: string; text: string }) =>
    request<{ ok: true }>(`/accounts/${encode(id)}/test-send`, 'POST', { chat, text }),
  native: ({ id, input }: { id: string; input: ChannelNativeAction }) =>
    request<unknown>(`/bindings/${encode(id)}/native`, 'POST', input),
}
/** enabled=false：扩展还没打开时不请求（接口会 404） */
export const useChannelAccounts = (enabled = true) =>
  useQuery({ queryKey: channelKeys.accounts, queryFn: channelsApi.accounts, enabled })
export const useChannelAccount = (id: string) =>
  useQuery({ queryKey: channelKeys.account(id), queryFn: () => channelsApi.account(id), enabled: !!id })
export const useChannelBindings = (accountId?: string) =>
  useQuery({ queryKey: channelKeys.bindings(accountId), queryFn: () => channelsApi.bindings(accountId) })
export const useChannelBinding = (id: string) =>
  useQuery({ queryKey: channelKeys.binding(id), queryFn: () => channelsApi.binding(id), enabled: !!id })
export const useChannelSettings = (id: string) =>
  useQuery({ queryKey: channelKeys.settings(id), queryFn: () => channelsApi.settings(id), enabled: !!id })
export const useChannelActors = () => useQuery({ queryKey: channelKeys.actors, queryFn: channelsApi.actors })
export const useChannelRequests = (accountId?: string) =>
  useQuery({ queryKey: channelKeys.requests(accountId), queryFn: () => channelsApi.requests(accountId) })
export const useChannelPresencePreview = (id: string) =>
  useQuery({
    queryKey: channelKeys.presence(id),
    queryFn: () => channelsApi.presencePreview(id),
    enabled: !!id,
    staleTime: 0,
  })
export const useChannelLog = () => useQuery({ queryKey: channelKeys.log, queryFn: channelsApi.log })
function useChannelMutation<T, R>(fn: (input: T) => Promise<R>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: channelKeys.all })
      void qc.invalidateQueries({ queryKey: ['chats'] })
      void qc.invalidateQueries({ queryKey: ['rooms'] })
    },
  })
}
export const useCreateChannelAccount = () => useChannelMutation(channelsApi.createAccount)
export const useUpdateChannelAccount = () => useChannelMutation(channelsApi.updateAccount)
export const useDeleteChannelAccount = () => useChannelMutation(channelsApi.deleteAccount)
export const useChannelAccountAction = () => useChannelMutation(channelsApi.accountAction)
export const useApplyChannelPresence = () => useChannelMutation(channelsApi.presenceApply)
export const useSyncChannelPresence = () => useChannelMutation(channelsApi.presenceSync)
export const useUpdateChannelPolicies = () => useChannelMutation(channelsApi.policies)
export const useRespondChannelRequest = () => useChannelMutation(channelsApi.respondRequest)
export const useUpdateChannelBinding = () => useChannelMutation(channelsApi.updateBinding)
export const useDisableChannelBinding = () => useChannelMutation(channelsApi.disableBinding)
export const useLeaveChannelBinding = () => useChannelMutation(channelsApi.leaveBinding)
export const useUpdateChannelActor = () => useChannelMutation(channelsApi.updateActor)
export const useConfirmChannelPairing = () => useChannelMutation(channelsApi.confirmPairing)
export const useChannelTestSend = () => useChannelMutation(channelsApi.testSend)
export const useChannelNativeAction = () => useChannelMutation(channelsApi.native)

export const useCreateChannelBinding = () => useChannelMutation(channelsApi.createBinding)

export const useManagedBotLink = () => useChannelMutation(channelsApi.managedBotLink)
export const useRotateManagedBotToken = () => useChannelMutation(channelsApi.rotateManagedBotToken)
export const useUpdateManagedBotAccess = () => useChannelMutation(channelsApi.updateManagedBotAccess)
export const useManagedBotAccess = (id: string) =>
  useQuery({ queryKey: channelKeys.managedAccess(id), queryFn: () => channelsApi.managedBotAccess(id), enabled: !!id })

export const useChannelFriends = (id: string) =>
  useQuery({ queryKey: channelKeys.friends(id), queryFn: () => channelsApi.friends(id), enabled: !!id })
export const useDeleteChannelFriend = () => useChannelMutation(channelsApi.deleteFriend)
export const useChannelOneBotAction = () => useChannelMutation(channelsApi.onebot)
export const useChannelStageLink = () => useChannelMutation(channelsApi.stageLink)

export const useRegenerateChannelIntro = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: channelsApi.regenerateIntro,
    onSuccess: (preview, id) => {
      qc.setQueryData(channelKeys.presence(id), preview)
      void qc.invalidateQueries({ queryKey: channelKeys.accounts })
      void qc.invalidateQueries({ queryKey: ['character'] })
      void qc.invalidateQueries({ queryKey: ['characters'] })
    },
  })
}

export const channelStickerPreviewUrl = (accountId: string, stickerId: string) =>
  `/api/ext/channels/accounts/${encode(accountId)}/stickers/${encode(stickerId)}/preview`
export function useChannelStickers(accountId: string) {
  return useQuery({
    queryKey: channelKeys.stickers(accountId),
    queryFn: () => channelsApi.stickers(accountId),
    enabled: !!accountId,
  })
}
function useStickerMutation<T>(mutationFn: (input: T) => Promise<ChannelStickersDTO>, account: (input: T) => string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: (data, input) => {
      queryClient.setQueryData(channelKeys.stickers(account(input)), data)
    },
  })
}
export const useAddStickerSet = () => useStickerMutation(channelsApi.addStickerSet, (input) => input.accountId)
export const useRefreshQqFaces = () => useStickerMutation(channelsApi.refreshQqFaces, (accountId) => accountId)
export const useUpdateSticker = () => useStickerMutation(channelsApi.updateSticker, (input) => input.accountId)
export const useDeleteSticker = () => useStickerMutation(channelsApi.deleteSticker, (input) => input.accountId)
