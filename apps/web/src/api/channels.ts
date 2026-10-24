import type {
  ChannelAccountDTO,
  ChannelAccountInput,
  ChannelActorDTO,
  ChannelBindingDTO,
  ChannelBindingInput,
  ChannelLogEntry,
  ChannelPolicies,
  ChannelPresencePreview,
  ChannelPresenceSync,
  ChannelRequestDTO,
  ChannelSettingsResolution,
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
  ChannelLogEntry,
  ChannelPolicies,
  ChannelPresence,
  ChannelPresencePreview,
  ChannelPresenceSync,
  ChannelProvider,
  ChannelRequestDTO,
  ChannelSettings,
  ChannelSettingsOverride,
  ChannelSettingsResolution,
} from '@nobot/shared'
export const channelKeys = {
  all: ['channels'] as const,
  accounts: ['channels', 'accounts'] as const,
  account: (id: string) => ['channels', 'account', id] as const,
  bindings: (accountId?: string) => ['channels', 'bindings', accountId ?? 'all'] as const,
  binding: (id: string) => ['channels', 'binding', id] as const,
  settings: (id: string) => ['channels', 'settings', id] as const,
  actors: ['channels', 'actors'] as const,
  requests: (accountId?: string) => ['channels', 'requests', accountId ?? 'all'] as const,
  presence: (id: string) => ['channels', 'presence', id] as const,
  log: ['channels', 'log'] as const,
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
export const channelsApi = {
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
  updateBinding: ({ id, patch }: { id: string; patch: Partial<ChannelBindingInput> }) =>
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
export const useChannelAccounts = () => useQuery({ queryKey: channelKeys.accounts, queryFn: channelsApi.accounts })
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
