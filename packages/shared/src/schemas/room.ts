import { z } from 'zod'

export const roomSettingsInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(4000).default(''),
  coverAsset: z.string().max(4000).nullable().default(null),
  mode: z.enum(['chat', 'trpg', 'custom']).default('chat'),
  turnMode: z.enum(['smart', 'auto', 'mention', 'host', 'initiative']).default('smart'),
  contentRating: z.enum(['general', 'mature', 'explicit']).default('general'),
  contentNotes: z.string().max(4000).default(''),
  rules: z.string().max(8000).default(''),
  gmApprovesCharacters: z.boolean().default(false),
  allowSpectators: z.boolean().default(false),
  spectatorHistory: z.enum(['all', 'since-join']).default('since-join'),
  maxSpectators: z.number().int().min(0).max(100).default(20),
  asyncMode: z.boolean().default(false),
  roundDeadlineHours: z.number().positive().max(8760).nullable().default(null),
  maxMembers: z.number().int().min(1).max(32).default(8),
  guestQuota: z
    .object({ perHour: z.number().int().min(0).default(30), perDay: z.number().int().min(0).default(300) })
    .default({ perHour: 30, perDay: 300 }),
  allowMemberInvites: z.boolean().default(false),
  allowGmKick: z.boolean().default(false),
  autoResolveWhenReady: z.boolean().default(true),
  choiceMode: z.enum(['gm', 'vote', 'each']).default('gm'),
  voteTimeoutSeconds: z.number().int().min(1).max(3600).default(60),
})
export const createRoomInput = roomSettingsInput.extend({
  turnMode: roomSettingsInput.shape.turnMode.removeDefault().optional(),
  chatId: z.string(),
  personaId: z.string().optional(),
})
// 更新不能套用创建默认值，否则只修改名称也会重置额度、回合模式与人数。
export const updateRoomInput = z.object({
  name: roomSettingsInput.shape.name.optional(),
  description: roomSettingsInput.shape.description.removeDefault().optional(),
  coverAsset: roomSettingsInput.shape.coverAsset.removeDefault().optional(),
  mode: roomSettingsInput.shape.mode.removeDefault().optional(),
  turnMode: roomSettingsInput.shape.turnMode.removeDefault().optional(),
  contentRating: roomSettingsInput.shape.contentRating.removeDefault().optional(),
  contentNotes: roomSettingsInput.shape.contentNotes.removeDefault().optional(),
  rules: roomSettingsInput.shape.rules.removeDefault().optional(),
  maxMembers: roomSettingsInput.shape.maxMembers.removeDefault().optional(),
  guestQuota: roomSettingsInput.shape.guestQuota.removeDefault().optional(),
  allowMemberInvites: roomSettingsInput.shape.allowMemberInvites.removeDefault().optional(),
  allowGmKick: roomSettingsInput.shape.allowGmKick.removeDefault().optional(),
  autoResolveWhenReady: roomSettingsInput.shape.autoResolveWhenReady.removeDefault().optional(),
  choiceMode: roomSettingsInput.shape.choiceMode.removeDefault().optional(),
  voteTimeoutSeconds: roomSettingsInput.shape.voteTimeoutSeconds.removeDefault().optional(),
  gmApprovesCharacters: roomSettingsInput.shape.gmApprovesCharacters.removeDefault().optional(),
  allowSpectators: roomSettingsInput.shape.allowSpectators.removeDefault().optional(),
  spectatorHistory: roomSettingsInput.shape.spectatorHistory.removeDefault().optional(),
  maxSpectators: roomSettingsInput.shape.maxSpectators.removeDefault().optional(),
  asyncMode: roomSettingsInput.shape.asyncMode.removeDefault().optional(),
  roundDeadlineHours: roomSettingsInput.shape.roundDeadlineHours.removeDefault().optional(),
  status: z.enum(['active', 'paused', 'archived']).optional(),
})
export const roomSendInput = z.object({
  images: z.array(z.string()).max(10).optional(),
  text: z.string().trim().min(1).max(100000),
  channel: z.enum(['ic', 'ooc']),
  clientMessageId: z.string().min(1).max(128),
  replyTo: z.string().optional(),
})
export const roomJoinInput = z.object({
  invite: z.string().min(1).max(256),
  personaId: z.string(),
  acceptedRulesVersion: z.number().int(),
})
export const roomPersonaInput = z
  .object({
    personaId: z.string().optional(),
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(8000).optional(),
  })
  .refine((value) => value.personaId !== undefined || value.name !== undefined || value.description !== undefined)
export const roomInviteInput = z.object({
  role: z.enum(['player', 'spectator']).default('player'),
  kind: z.enum(['direct', 'link']),
  targetUserId: z.string().optional(),
  expiresIn: z.number().int().min(1).max(604800000).default(86400000),
  maxUses: z.number().int().min(1).max(10000).optional(),
})
export type RoomRole = 'owner' | 'gm' | 'player' | 'spectator'
export interface RoomPermissions {
  isSpectator: boolean
  canProposeCharacter: boolean
  canApproveCharacters: boolean
  canExport: boolean
  canSchedule: boolean
  canTransfer: boolean
  canSend: boolean
  canSendIc: boolean
  canWhisper: boolean
  canRoll: boolean
  canPickChoice: boolean
  canRegenerate: boolean
  canSwipe: boolean
  canEditAi: boolean
  canTrigger: boolean
  canContinue: boolean
  canAbort: boolean
  canInvite: boolean
  canKick: boolean
  canManageRounds: boolean
  canManageInitiative: boolean
  canCloseChoices: boolean
  canGenerateImages: boolean
  canManage: boolean
}
export interface RoomMemberDTO {
  notifyPreference: 'all' | 'mentions' | 'none'
  joinedSeq: number
  inRoom?: boolean
  roomId: string
  userId: string
  role: RoomRole
  state: 'active' | 'left' | 'kicked'
  personaName: string
  personaDescription: string
  personaAvatarFile: string | null
  acceptedRulesVersion: number
  joinedAt: number
  lastReadSeq: number
}
export interface RoomDTO extends z.infer<typeof roomSettingsInput> {
  alreadyInRoom?: boolean
  id: string
  hostUserId: string
  chatId: string
  rulesVersion: number
  status: 'active' | 'paused' | 'archived'
  createdAt: number
  updatedAt: number
  members: RoomMemberDTO[]
  spectators: RoomMemberDTO[]
  nextSession: RoomSessionDTO | null
  myUserId: string
  myRole: RoomRole
  permissions: RoomPermissions
  unreadCount: number
  round: RoomRoundState
  initiative: RoomInitiativeState
}
export interface RoomInviteDTO {
  status: 'active' | 'used_up' | 'expired' | 'revoked'
  role: 'player' | 'spectator'
  id: string
  roomId: string
  createdBy: string
  kind: 'direct' | 'link'
  targetUserId: string | null
  expiresAt: number
  maxUses: number | null
  uses: number
  revokedAt: number | null
}
export interface RoomLobbyDTO {
  alreadyInRoom?: boolean
  room?: RoomDTO
  inviteRole: 'player' | 'spectator'
  spectators: string[]
  spectatorHistory: 'all' | 'since-join'
  id: string
  name: string
  description: string
  coverAsset: string | null
  hostName: string
  members: string[]
  characters: { name: string; avatarUrl: string | null; description: string }[]
  contentRating: 'general' | 'mature' | 'explicit'
  contentNotes: string
  rules: string
  rulesVersion: number
  payer: string
  historyNote: string
  guestQuota: { perHour: number; perDay: number }
}
export interface RoomEvent {
  roomId: string
  seq?: number
  type: string
  actorId: string
  entityId?: string | null
  payload: Record<string, unknown>
  createdAt: number
}
export function roomPermissions(
  role: RoomRole,
  active: boolean,
  accepted: boolean,
  memberInvites = false,
  gmKick = false,
): RoomPermissions {
  const gm = role === 'owner' || role === 'gm'
  const participant = role !== 'spectator'
  return {
    isSpectator: !participant,
    canProposeCharacter: participant && active && accepted,
    canApproveCharacters: role === 'owner',
    canExport: true,
    canSchedule: gm,
    canTransfer: role === 'owner',
    canSend: participant && active && accepted,
    canSendIc: participant && active && accepted,
    canWhisper: participant && active && accepted,
    canRoll: participant && active && accepted,
    canPickChoice: participant && active && accepted,
    canRegenerate: gm && participant && active && accepted,
    canSwipe: gm,
    canEditAi: gm,
    canTrigger: gm && participant && active && accepted,
    canContinue: gm && participant && active && accepted,
    canAbort: gm,
    canInvite: gm || (participant && memberInvites),
    canKick: role === 'owner' || (role === 'gm' && gmKick),
    canManageRounds: gm,
    canManageInitiative: gm,
    canCloseChoices: gm,
    canGenerateImages: role === 'owner',
    canManage: role === 'owner',
  }
}

export type CreateRoomInput = z.input<typeof createRoomInput>
export type UpdateRoomInput = z.input<typeof updateRoomInput>
export type RoomInviteInput = z.input<typeof roomInviteInput>
export type RoomJoinInput = z.input<typeof roomJoinInput>
export type RoomSendInput = z.input<typeof roomSendInput>
export type RoomPersonaInput = z.input<typeof roomPersonaInput>

export const rollVisibility = z.enum(['public', 'gm', 'blind', 'self'])
export type RollVisibility = z.infer<typeof rollVisibility>
export const roomRollInput = z.object({
  expression: z.string().trim().min(1).max(100),
  reason: z.string().max(1000).optional(),
  visibility: rollVisibility.default('public'),
})
export const roomWhisperInput = z.object({
  text: z.string().trim().min(1).max(100000),
  to: z.string().min(1),
  clientMessageId: z.string().min(1).max(128),
})
export const roomInitiativeInput = z.object({
  order: z.array(z.object({ kind: z.enum(['member', 'character']), id: z.string().min(1) })).max(64),
  current: z.number().int().min(0).optional(),
})
export interface RoomRoundState {
  deadline?: number
  round: number
  members: Record<string, 'pending' | 'done' | 'passed' | 'away'>
}
export interface RoomInitiativeState {
  order: { kind: 'member' | 'character'; id: string }[]
  current: number
}
export interface RoomChoiceState {
  messageId: string
  votes: Record<string, number>
  picks: string[]
  closed: boolean
  winner: number | null
  deadline: number
  counts: number[]
}
export type RoomRollInput = z.input<typeof roomRollInput>
export type RoomWhisperInput = z.input<typeof roomWhisperInput>
export type RoomInitiativeInput = z.input<typeof roomInitiativeInput>

export const roomCharacterProposalInput = z.object({
  characterId: z.string().min(1),
  share: z.object({
    description: z.boolean(),
    personality: z.boolean(),
    scenario: z.boolean(),
    exampleDialogue: z.boolean(),
    sprites: z.boolean(),
    voice: z.boolean(),
    lorebook: z.boolean(),
  }),
  note: z.string().max(4000).default(''),
})
export type RoomCharacterProposalInput = z.input<typeof roomCharacterProposalInput>
export interface RoomCharacterProposalDTO {
  id: string
  roomId: string
  userId: string
  sourceCharacterId: string
  preview: {
    name: string
    description?: string
    personality?: string
    scenario?: string
    mesExample?: string
    avatarUrl: string | null
    sprites: { count: number; thumbnails: string[] }
    lorebooks: { name: string; entryCount: number }[]
    voice: boolean
  }
  note: string
  status: 'pending' | 'approved' | 'rejected'
  copyId: string | null
  createdAt: number
}
export const roomSessionInput = z.object({
  title: z.string().trim().min(1).max(200),
  startsAt: z.number().int().min(0),
  durationMinutes: z.number().int().min(1).max(10080),
  note: z.string().max(4000).default(''),
})
export type RoomSessionInput = z.input<typeof roomSessionInput>
export interface RoomSessionDTO extends z.output<typeof roomSessionInput> {
  id: string
  roomId: string
  createdBy: string
  cancelledAt: number | null
  myRsvp: 'yes' | 'maybe' | 'no' | null
}
export interface RoomUnreadDTO {
  count: number
  firstUnreadMessageId: string | null
  latestSeq: number
}
export interface RoomTransferDTO {
  roomId: string
  fromUserId: string
  toUserId: string
  createdAt: number
}
