import { z } from 'zod'

export const channelProvider = z.enum(['telegram', 'onebot11'])
export type ChannelProvider = z.infer<typeof channelProvider>
export const channelSettingsSchema = z.object({
  stickerFrequency: z.enum(['off', 'rarely', 'sometimes', 'often']).default('sometimes'),
  stickerCooldownSec: z.number().int().min(0).max(86400).default(30),
  stickerAutoLearn: z.boolean().default(true),
  stickerAutoLabel: z.boolean().default(false),
  stickerMaxSets: z.number().int().min(0).max(300).default(30),
  multiSpeaker: z.enum(['prefix', 'forward']).default('prefix'),
  controlsFooter: z.boolean().default(false),
  groupCard: z.boolean().default(true),
  onlineStatus: z.enum(['off', 'follow']).default('off'),
  tempSessionDm: z.boolean().default(false),
  pokeBack: z.boolean().default(false),
  pokeToStory: z.boolean().default(false),
  dailySign: z.boolean().default(false),
  maxMessageLength: z.number().int().min(100).max(4500).default(4500),
  socialCooldownMs: z.number().int().min(1000).default(60000),
  // 0 表示不限每日次数，仍受开关和冷却限制。
  socialDailyBudget: z.number().int().min(0).max(1000).default(20),
  miniAppButton: z.boolean().default(true),
  miniAppMenuButton: z.boolean().default(true),
  voice: z.enum(['off', 'auto', 'button', 'only', 'decide']).default('button'),
  voiceDecideBias: z.enum(['low', 'medium', 'high']).default('medium'),
  voiceDecideStyle: z.enum(['only', 'with-text']).default('only'),
  voiceDecideHourlyMax: z.number().int().min(0).default(10),
  voiceNarration: z.enum(['speak', 'text', 'drop']).default('text'),
  voiceLongText: z.enum(['split', 'text']).default('split'),
  voiceMaxChars: z.number().int().min(1).max(4500).default(300),
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
  // 0 表示不限每日次数，仍受开关和冷却限制。
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
  joinRequests: z.enum(['ignore', 'notify']).default('ignore'),
  friendRequest: z.enum(['never', 'paired', 'all']).default('paired'),
  idleLeave: z
    .object({
      enabled: z.boolean().default(false),
      idleDays: z.number().int().min(1).default(30),
      graceDays: z.number().int().min(1).default(7),
      excluded: z.array(z.string()).default([]),
    })
    .prefault({}),
  limits: z
    .object({
      maxGroups: z.number().int().min(1).max(1000).default(20),
      maxFriends: z.number().int().min(1).max(10000).default(100),
    })
    .prefault({}),
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
  description: presenceField
    .extend({ introSource: z.enum(['auto', 'creator-notes', 'description', 'model', 'rules']).default('auto') })
    .prefault({}),
  shortDescription: presenceField
    .extend({ introSource: z.enum(['auto', 'creator-notes', 'description', 'model', 'rules']).default('auto') })
    .prefault({}),
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
export const channelAccountInput = z
  .object({
    provider: channelProvider.default('telegram'),
    name: z.string().trim().min(1).max(120),
    credentials: z
      .object({
        token: z.string().default(''),
        accessToken: z.string().optional(),
        webhookSecret: z.string().optional(),
      })
      .default({ token: '' }),
    connection: z
      .object({ mode: z.enum(['ws-forward', 'ws-reverse']), url: z.string().default('') })
      .nullable()
      .default(null),
    rateLimit: z
      .object({
        perMinute: z.number().int().min(1).max(120).default(20),
        minIntervalMs: z.number().int().min(1200).max(60000).default(1200),
      })
      .prefault({}),
    baseUrl: z.url().default('https://api.telegram.org'),
    webhookUrl: z.url().nullable().default(null),
    receiveMode: z.enum(['polling', 'webhook', 'ws-forward', 'ws-reverse']).default('polling'),
    characterMode: z.enum(['fixed', 'generic']).default('generic'),
    characterId: z.string().nullable().default(null),
    groupId: z.string().nullable().default(null),
    defaultCharacterId: z.string().nullable().default(null),
    // 空列表允许账号访问主人的全部角色。
    characterAllowlist: z.array(z.string()).default([]),
    personaMode: channelPersonaMode.default('platform-name'),
    globalPersonaId: z.string().nullable().default(null),
    personaLocked: z.boolean().default(false),
    presence: channelPresenceSchema.prefault({}),
    policies: channelPoliciesSchema.prefault({}),
    settings: channelSettingsOverrideSchema.default({}),
  })
  .superRefine((input, context) => {
    if (input.provider === 'telegram' && !input.credentials.token)
      context.addIssue({ code: 'custom', path: ['credentials', 'token'], message: '渠道设置无效' })
    if (input.provider === 'onebot11') {
      if (!(input.credentials.accessToken ?? input.credentials.token))
        context.addIssue({ code: 'custom', path: ['credentials', 'accessToken'], message: '渠道设置无效' })
      if (!input.connection) context.addIssue({ code: 'custom', path: ['connection'], message: '渠道设置无效' })
      else if (input.connection.mode === 'ws-forward') {
        try {
          const url = new URL(input.connection.url)
          if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
            throw new Error('URL')
        } catch {
          context.addIssue({ code: 'custom', path: ['connection', 'url'], message: '渠道设置无效' })
        }
      }
    }
  })
export type ChannelAccountInput = z.input<typeof channelAccountInput>
export type ChannelAccountConfig = z.infer<typeof channelAccountInput>
export interface ChannelAccountDTO extends Omit<ChannelAccountConfig, 'credentials'> {
  riskNotice: string | null
  implementation: { name: string; version: string } | null
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
  canManageBots: boolean
  managedBy: string | null
  miniApp: { available: boolean; reason?: string; url?: string }
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
  voicePreference?: { bias?: 'low' | 'medium' | 'high'; suppressed?: boolean; updatedAt: number } | null
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
export interface ChannelFriendDTO {
  user_id: number
  nickname: string
  remark: string
}
export interface ChannelRequestDTO {
  expiresAt: number | null
  id: string
  accountId: string
  kind: 'group-invite' | 'friend' | 'new-location' | 'join-request'
  chat: string
  title: string
  actorExternalId: string | null
  actorName: string | null
  state: 'pending' | 'approved' | 'rejected' | 'blocked' | 'expired'
  createdAt: number
}
export interface ChannelLogEntry {
  at: number
  accountId: string
  bindingId?: string
  code: string
  message: string
}
export interface ChannelPresenceValue {
  value: string
  source: 'explicit' | 'generated' | 'creator-notes' | 'description' | 'rules' | 'custom'
  language?: 'zh' | 'en'
}
export interface ChannelPresencePreview {
  /** 保留原字符串映射；fields 和 languages 提供来源及多语言预览。 */
  fields: Record<string, ChannelPresenceValue>
  languages: Record<'zh' | 'en', Record<string, ChannelPresenceValue>>
  current: Record<string, string>
  desired: Record<string, string>
  confirmed: boolean
}

/** 只保存平台引用；禁止在表情引用中放入本机路径或图片字节。 */
export type ChannelStickerRef =
  | {
      kind: 'telegram'
      file_id: string
      file_unique_id: string
      set_name?: string
      emoji?: string
      type: 'regular' | 'mask' | 'custom_emoji'
      format: 'static' | 'animated' | 'video'
      thumbnail?: string
    }
  | { kind: 'face'; id: string }
  | { kind: 'mface'; emoji_package_id: string; emoji_id: string; key: string; summary?: string; url?: string }
  | { kind: 'image'; id: string; url: string; sub_type: number; summary?: string }
export interface ChannelStickerDTO {
  id: string
  groupId: string
  accountId: string
  ref: ChannelStickerRef
  meanings: string[]
  enabled: boolean
  characters: string[]
  usageCount: number
  previewUrl: string | null
}
export interface ChannelStickerGroupDTO {
  id: string
  accountId: string
  source: 'telegram-set' | 'telegram-learned' | 'qq-face' | 'qq-collected' | 'qq-learned'
  name: string
  title: string
  enabled: boolean
  characters: string[]
  count: number
  enabledCount: number
  entries: ChannelStickerDTO[]
}
export interface ChannelStickersDTO {
  groups: ChannelStickerGroupDTO[]
  count: number
}
export interface ChannelStickerPatch {
  enabled?: boolean
  characters?: string[]
  meanings?: string[]
}
