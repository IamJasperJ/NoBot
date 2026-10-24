import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    handle: text('handle').notNull().unique(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    kind: text('kind', { enum: ['normal', 'external'] })
      .notNull()
      .default('normal'),
    externalProvider: text('external_provider'),
    externalId: text('external_id'),
    externalOwnerUserId: text('external_owner_user_id').references((): AnySQLiteColumn => users.id, {
      onDelete: 'cascade',
    }),
    avatarFile: text('avatar_file'),
    isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    lastLoginAt: integer('last_login_at'),
  },
  (t) => [uniqueIndex('external_user_identity_idx').on(t.externalProvider, t.externalOwnerUserId, t.externalId)],
)
export const sessions = sqliteTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    scope: text('scope', { mode: 'json' }).$type<{ kind: 'room'; roomId: string } | { kind: 'chat'; chatId: string }>(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at').notNull(),
    renewedAt: integer('renewed_at').notNull(),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId), index('sessions_expires_at_idx').on(table.expiresAt)],
)

const userRef = (name: string) =>
  text(name)
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' })
export const friendships = sqliteTable(
  'friendships',
  {
    userA: userRef('user_a'),
    userB: userRef('user_b'),
    status: text('status', { enum: ['pending', 'accepted'] }).notNull(),
    requestedBy: userRef('requested_by'),
    createdAt: integer('created_at').notNull(),
    respondedAt: integer('responded_at'),
  },
  (t) => [primaryKey({ columns: [t.userA, t.userB] })],
)
export const userBlocks = sqliteTable(
  'user_blocks',
  {
    blockerId: userRef('blocker_id'),
    blockedId: userRef('blocked_id'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] })],
)
export const notifications = sqliteTable(
  'notifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: userRef('user_id'),
    type: text('type').notNull(),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'cascade' }),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer('created_at').notNull(),
    readAt: integer('read_at'),
    dismissedAt: integer('dismissed_at'),
  },
  (t) => [index('notifications_user_id_id_idx').on(t.userId, t.id)],
)
export const userPresencePrefs = sqliteTable('user_presence_prefs', {
  userId: userRef('user_id').primaryKey(),
  status: text('status', { enum: ['auto', 'dnd', 'invisible'] }).notNull(),
})

export const rooms = sqliteTable(
  'rooms',
  {
    id: text('id').primaryKey(),
    hostUserId: userRef('host_user_id'),
    chatId: text('chat_id').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    coverAsset: text('cover_asset'),
    mode: text('mode', { enum: ['chat', 'trpg', 'custom'] })
      .notNull()
      .default('chat'),
    turnMode: text('turn_mode', { enum: ['smart', 'auto', 'mention', 'host', 'initiative'] })
      .notNull()
      .default('smart'),
    contentRating: text('content_rating', { enum: ['general', 'mature', 'explicit'] })
      .notNull()
      .default('general'),
    contentNotes: text('content_notes').notNull().default(''),
    rules: text('rules').notNull().default(''),
    rulesVersion: integer('rules_version').notNull().default(1),
    gmApprovesCharacters: integer('gm_approves_characters', { mode: 'boolean' }).notNull().default(false),
    allowSpectators: integer('allow_spectators', { mode: 'boolean' }).notNull().default(false),
    spectatorHistory: text('spectator_history', { enum: ['all', 'since-join'] })
      .notNull()
      .default('since-join'),
    maxSpectators: integer('max_spectators').notNull().default(20),
    asyncMode: integer('async_mode', { mode: 'boolean' }).notNull().default(false),
    roundDeadlineHours: integer('round_deadline_hours'),
    maxMembers: integer('max_members').notNull().default(8),
    guestQuota: text('guest_quota', { mode: 'json' })
      .$type<{ perHour: number; perDay: number }>()
      .notNull()
      .default({ perHour: 30, perDay: 300 }),
    allowMemberInvites: integer('allow_member_invites', { mode: 'boolean' }).notNull().default(false),
    allowGmKick: integer('allow_gm_kick', { mode: 'boolean' }).notNull().default(false),
    autoResolveWhenReady: integer('auto_resolve_when_ready', { mode: 'boolean' }).notNull().default(true),
    choiceMode: text('choice_mode', { enum: ['gm', 'vote', 'each'] })
      .notNull()
      .default('gm'),
    voteTimeoutSeconds: integer('vote_timeout_seconds').notNull().default(60),
    status: text('status', { enum: ['active', 'paused', 'archived'] })
      .notNull()
      .default('active'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('rooms_host_idx').on(t.hostUserId)],
)
const roomRef = () =>
  text('room_id')
    .notNull()
    .references(() => rooms.id, { onDelete: 'cascade' })
export const roomMembers = sqliteTable(
  'room_members',
  {
    roomId: roomRef(),
    userId: userRef('user_id'),
    role: text('role', { enum: ['owner', 'gm', 'player', 'spectator'] }).notNull(),
    state: text('state', { enum: ['active', 'left', 'kicked'] })
      .notNull()
      .default('active'),
    personaName: text('persona_name').notNull(),
    personaDescription: text('persona_description').notNull(),
    personaAvatarFile: text('persona_avatar_file'),
    acceptedRulesVersion: integer('accepted_rules_version').notNull(),
    joinedAt: integer('joined_at').notNull(),
    joinedSeq: integer('joined_seq').notNull().default(0),
    notifyPreference: text('notify_preference', { enum: ['all', 'mentions', 'none'] })
      .notNull()
      .default('all'),
    lastReadSeq: integer('last_read_seq').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.userId] }), index('room_members_user_idx').on(t.userId, t.state)],
)
export const roomInvites = sqliteTable('room_invites', {
  id: text('id').primaryKey(),
  roomId: roomRef(),
  createdBy: userRef('created_by'),
  role: text('role', { enum: ['player', 'spectator'] })
    .notNull()
    .default('player'),
  kind: text('kind', { enum: ['direct', 'link'] }).notNull(),
  targetUserId: text('target_user_id').references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').unique(),
  expiresAt: integer('expires_at').notNull(),
  maxUses: integer('max_uses'),
  uses: integer('uses').notNull().default(0),
  revokedAt: integer('revoked_at'),
})
export const roomBans = sqliteTable(
  'room_bans',
  {
    roomId: roomRef(),
    userId: userRef('user_id'),
    by: userRef('by'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.userId] })],
)

/** 提案快照仅存明确共享字段，不持有来源用户的上下文或私人卡片。 */
export const roomCharacterProposals = sqliteTable('room_character_proposals', {
  id: text('id').primaryKey(),
  roomId: roomRef(),
  userId: userRef('user_id'),
  sourceCharacterId: text('source_character_id').notNull(),
  preview: text('preview', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  note: text('note').notNull(),
  status: text('status', { enum: ['pending', 'approved', 'rejected'] })
    .notNull()
    .default('pending'),
  copyId: text('copy_id'),
  createdAt: integer('created_at').notNull(),
})
export const roomSessions = sqliteTable('room_sessions', {
  id: text('id').primaryKey(),
  roomId: roomRef(),
  title: text('title').notNull(),
  startsAt: integer('starts_at').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  note: text('note').notNull(),
  createdBy: userRef('created_by'),
  cancelledAt: integer('cancelled_at'),
  remindedAt: integer('reminded_at'),
})
export const roomSessionRsvps = sqliteTable(
  'room_session_rsvps',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => roomSessions.id, { onDelete: 'cascade' }),
    userId: userRef('user_id'),
    response: text('response', { enum: ['yes', 'maybe', 'no'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.userId] })],
)
export const roomTransfers = sqliteTable('room_transfers', {
  roomId: roomRef().primaryKey(),
  fromUserId: userRef('from_user_id'),
  toUserId: userRef('to_user_id'),
  createdAt: integer('created_at').notNull(),
})
export const roomNotificationDeliveries = sqliteTable('room_notification_deliveries', {
  key: text('key').primaryKey(),
  roomId: roomRef(),
  createdAt: integer('created_at').notNull(),
})

/** 启动索引只含路由信息，凭据始终留在所属用户库。 */
export const channelRegistry = sqliteTable(
  'channel_registry',
  {
    userHandle: text('user_handle')
      .notNull()
      .references(() => users.handle, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    provider: text('provider').notNull(),
    receiveMode: text('receive_mode').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.userHandle, t.accountId] })],
)
