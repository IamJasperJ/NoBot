import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  handle: text('handle').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  lastLoginAt: integer('last_login_at'),
})
export const sessions = sqliteTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
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
