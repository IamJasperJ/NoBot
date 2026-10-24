import { z } from 'zod'

export const channelProvider = z.enum(['telegram', 'onebot11'])
export type ChannelProvider = z.infer<typeof channelProvider>
export const channelSettingsSchema = z.object({
  voice: z.enum(['off', 'auto', 'button']).default('button'),
  voiceInput: z.boolean().default(true),
  echoTranscript: z.boolean().default(true),
  sprites: z.enum(['off', 'changes', 'every']).default('off'),
  cg: z.enum(['send', 'spoiler', 'off']).default('send'),
  generatedImages: z.enum(['send', 'spoiler', 'off']).default('send'),
  background: z.boolean().default(false),
  statusCard: z.enum(['off', 'every', 'pinned']).default('off'),
  diceAnimation: z.boolean().default(false),
  stream: z.boolean().default(true),
  streamIntervalMs: z.number().int().min(250).max(60000).default(1500),
  thinking: z.enum(['fold', 'omit']).default('omit'),
  regenerateButton: z.boolean().default(true),
  previousButton: z.boolean().default(true),
  nextButton: z.boolean().default(true),
  continueButton: z.boolean().default(true),
  deleteButton: z.boolean().default(false),
  queueMode: z.enum(['merge', 'interrupt']).default('merge'),
  actorRateLimit: z.number().int().min(1).max(1000).default(20),
  mirrorWebMessages: z.boolean().default(true),
  personaPrefix: z.boolean().default(true),
  deleteSync: z.boolean().default(false),
  mentionOnTurn: z.boolean().default(true),
  reactions: z.boolean().default(false),
  reactionCooldownMs: z.number().int().min(1000).default(60000),
  reactionDailyBudget: z.number().int().min(0).max(1000).default(20),
})
// 覆盖对象不能沿用字段默认值，否则未填写的键也会被标成显式覆盖。
export const channelSettingsOverrideSchema = z.object(
  Object.fromEntries(
    Object.entries(channelSettingsSchema.shape).map(([key, schema]) => [key, schema.removeDefault().optional()]),
  ) as {
    [K in keyof typeof channelSettingsSchema.shape]: z.ZodOptional<
      ReturnType<(typeof channelSettingsSchema.shape)[K]['removeDefault']>
    >
  },
)
export type ChannelSettings = z.infer<typeof channelSettingsSchema>
export type ChannelSettingsOverride = Partial<ChannelSettings>
export type ChannelSettingsResolution = {
  values: ChannelSettings
  provenance: Record<keyof ChannelSettings, 'global' | 'account' | 'binding'>
}
export const channelPoliciesSchema = z.object({
  groupInvite: z.enum(['never', 'approve', 'trusted', 'all']).default('approve'),
  newLocation: z
    .object({
      private: z.enum(['auto', 'approve', 'existing-only']).default('auto'),
      group: z.enum(['auto', 'approve', 'existing-only']).default('approve'),
    })
    .prefault({}),
  friendRequest: z.enum(['never', 'paired', 'all']).default('paired'),
  idleLeave: z
    .object({
      enabled: z.boolean().default(false),
      idleDays: z.number().int().min(1).default(30),
      graceDays: z.number().int().min(1).default(7),
      excluded: z.array(z.string()).default([]),
    })
    .prefault({}),
  limits: z.object({ maxGroups: z.number().int().min(1).max(1000).default(20) }).prefault({}),
})
export type ChannelPolicies = z.infer<typeof channelPoliciesSchema>
const presenceField = z.object({
  mode: z.enum(['follow-character', 'custom', 'unmanaged']).default('unmanaged'),
  value: z.string().default(''),
  languages: z.object({ zh: z.string().optional(), en: z.string().optional() }).default({}),
})
export const channelPresenceSchema = z.object({
  characterId: z.string().nullable().default(null),
  confirmed: z.boolean().default(false),
  avatar: presenceField.prefault({}),
  name: presenceField.prefault({}),
  description: presenceField.prefault({}),
  shortDescription: presenceField.prefault({}),
})
export type ChannelPresence = z.infer<typeof channelPresenceSchema>
export type ChannelCapabilityState = 'supported' | 'unsupported' | 'unknown' | 'console_only' | 'permission_required'
export type ChannelCapabilities = Record<string, ChannelCapabilityState>
export type ChannelPresenceSync = Record<
  string,
  {
    desiredHash: string
    attempts?: number
    appliedHash: string | null
    lastAttemptAt: number | null
    error: string | null
    nextRetryAt: number | null
  }
>
export const channelPersonaMode = z.enum(['platform-name', 'global', 'per-actor', 'owner-assigned'])
export const channelAccountInput = z.object({
  provider: channelProvider.default('telegram'),
  name: z.string().trim().min(1).max(120),
  credentials: z.object({ token: z.string().min(1), webhookSecret: z.string().optional() }),
  baseUrl: z.url().default('https://api.telegram.org'),
  webhookUrl: z.url().nullable().default(null),
  receiveMode: z.enum(['polling', 'webhook']).default('polling'),
  characterMode: z.enum(['fixed', 'generic']).default('generic'),
  characterId: z.string().nullable().default(null),
  groupId: z.string().nullable().default(null),
  defaultCharacterId: z.string().nullable().default(null),
  personaMode: channelPersonaMode.default('platform-name'),
  globalPersonaId: z.string().nullable().default(null),
  personaLocked: z.boolean().default(false),
  presence: channelPresenceSchema.prefault({}),
  policies: channelPoliciesSchema.prefault({}),
  settings: channelSettingsOverrideSchema.default({}),
})
export type ChannelAccountInput = z.input<typeof channelAccountInput>
export type ChannelAccountConfig = z.infer<typeof channelAccountInput>
export interface ChannelAccountDTO extends Omit<ChannelAccountConfig, 'credentials'> {
  id: string
  credentials: string
  status: 'stopped' | 'connecting' | 'online' | 'error'
  lastError: string | null
  cursor: number | null
  botId: string | null
  botUsername: string | null
  botSnapshot: Record<string, unknown>
  capabilities: ChannelCapabilities
  presenceSync: ChannelPresenceSync
  bindingCount: number
  pendingRequestCount: number
}
export const channelBindingInput = z.object({
  accountId: z.string(),
  scope: z.enum(['private', 'group']),
  chat: z.string(),
  title: z.string().default(''),
  thread: z.string().default(''),
  actor: z.string().default(''),
  isolation: z.enum(['dm', 'shared', 'per-user', 'per-topic']).default('shared'),
  source: z.enum(['new', 'attached', 'account-shared']).default('new'),
  chatId: z.string(),
  roomId: z.string().nullable().default(null),
  state: z.enum(['pending', 'active', 'disabled', 'left']).default('pending'),
  speakers: z.record(z.string(), z.string()).default({}),
  trigger: z.enum(['follow-room', 'mention', 'reply', 'command', 'all']).default('follow-room'),
  personaMode: channelPersonaMode.nullable().default(null),
  settings: channelSettingsOverrideSchema.default({}),
})
export type ChannelBindingInput = z.input<typeof channelBindingInput>
export interface ChannelBindingDTO extends z.infer<typeof channelBindingInput> {
  id: string
  memberCount: number
  chatTitle: string
  lastActivityAt: number
  createdBy: string
  idleWarnedAt: number | null
}
export interface ChannelActorDTO {
  personaName?: string | null
  personaDescription?: string | null
  id: string
  provider: ChannelProvider
  externalId: string
  displayName: string
  accountIds: string[]
  lastSeenAt: number | null
  username: string | null
  linkedUserId: string | null
  externalUserId: string | null
  role: 'owner' | 'player' | 'blocked'
  personaId: string | null
  dmChatId: string | null
}
export interface ChannelRequestDTO {
  id: string
  accountId: string
  kind: 'group-invite' | 'friend' | 'new-location'
  chat: string
  title: string
  actorExternalId: string | null
  actorName: string | null
  state: 'pending' | 'approved' | 'rejected' | 'blocked'
  createdAt: number
}
export interface ChannelLogEntry {
  at: number
  accountId: string
  bindingId?: string
  code: string
  message: string
}
export interface ChannelPresencePreview {
  current: Record<string, string>
  desired: Record<string, string>
  confirmed: boolean
}
