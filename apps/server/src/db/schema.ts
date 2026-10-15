import type { ApiParams, MessageMeta, MessageRole, MessageStatus } from '@ai-parter/shared'
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * 数据库表结构，和设计文档「数据模型」一节一一对应。
 * 时间统一存毫秒时间戳；id 统一用 ULID（按时间有序的字符串）。
 * 世界书相关的表现在就建好，里程碑 5 再用，避免以后改表结构。
 */

const timestamps = {
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}

export const characters = sqliteTable('characters', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  personality: text('personality').notNull().default(''),
  scenario: text('scenario').notNull().default(''),
  firstMes: text('first_mes').notNull().default(''),
  alternateGreetings: text('alternate_greetings', { mode: 'json' }).$type<string[]>().notNull().default([]),
  mesExample: text('mes_example').notNull().default(''),
  systemPrompt: text('system_prompt').notNull().default(''),
  postHistoryInstructions: text('post_history_instructions').notNull().default(''),
  creatorNotes: text('creator_notes').notNull().default(''),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
  /** 头像文件名（不含目录），没有头像时为空 */
  avatarFile: text('avatar_file'),
  /** 导入时的整张卡，原样保存，导出时不丢字段 */
  raw: text('raw', { mode: 'json' }).$type<Record<string, unknown>>(),
  ...timestamps,
})

/** 用户人设，即 {{user}} */
export const personas = sqliteTable('personas', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  ...timestamps,
})

export const lorebooks = sqliteTable('lorebooks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  scanDepth: integer('scan_depth').notNull().default(4),
  tokenBudget: integer('token_budget').notNull().default(1024),
  /** 是否允许条目内容继续触发其他条目 */
  recursive: integer('recursive', { mode: 'boolean' }).notNull().default(false),
  isGlobal: integer('is_global', { mode: 'boolean' }).notNull().default(false),
  ...timestamps,
})

export const lorebookEntries = sqliteTable(
  'lorebook_entries',
  {
    id: text('id').primaryKey(),
    lorebookId: text('lorebook_id')
      .notNull()
      .references(() => lorebooks.id, { onDelete: 'cascade' }),
    keys: text('keys', { mode: 'json' }).$type<string[]>().notNull().default([]),
    secondaryKeys: text('secondary_keys', { mode: 'json' }).$type<string[]>().notNull().default([]),
    selectiveLogic: text('selective_logic', { enum: ['and_any', 'and_all', 'not_any', 'not_all'] })
      .notNull()
      .default('and_any'),
    content: text('content').notNull().default(''),
    constant: integer('constant', { mode: 'boolean' }).notNull().default(false),
    position: text('position', { enum: ['before_char', 'after_char', 'before_an', 'after_an', 'at_depth'] })
      .notNull()
      .default('before_char'),
    depth: integer('depth').notNull().default(4),
    order: integer('order').notNull().default(100),
    probability: integer('probability').notNull().default(100),
    /** 为空时继承所属世界书的设置 */
    caseSensitive: integer('case_sensitive', { mode: 'boolean' }),
    wholeWords: integer('whole_words', { mode: 'boolean' }),
    scanDepth: integer('scan_depth'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    comment: text('comment').notNull().default(''),
  },
  (t) => [index('lorebook_entries_book_idx').on(t.lorebookId)],
)

export const apiPresets = sqliteTable('api_presets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  /** 本地数据库明文保存，接口返回时打码；将来部署到服务器时再加密 */
  apiKey: text('api_key').notNull().default(''),
  model: text('model').notNull(),
  contextSize: integer('context_size').notNull().default(16384),
  params: text('params', { mode: 'json' }).$type<ApiParams>().notNull(),
  ...timestamps,
})

export const promptPresets = sqliteTable('prompt_presets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** 有序的 block 列表，里程碑 4 定义具体结构 */
  blocks: text('blocks', { mode: 'json' }).$type<unknown[]>().notNull().default([]),
  ...timestamps,
})

export const chats = sqliteTable(
  'chats',
  {
    id: text('id').primaryKey(),
    characterId: text('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    personaId: text('persona_id').references(() => personas.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    /** 当前分支的叶子节点。不加外键：删除消息时由业务代码负责更新它 */
    activeLeafId: text('active_leaf_id'),
    apiPresetId: text('api_preset_id').references(() => apiPresets.id, { onDelete: 'set null' }),
    promptPresetId: text('prompt_preset_id').references(() => promptPresets.id, { onDelete: 'set null' }),
    authorNote: text('author_note').notNull().default(''),
    authorNoteDepth: integer('author_note_depth').notNull().default(4),
    /** 会话级变量，以后给跑团状态和记忆功能用 */
    vars: text('vars', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [index('chats_character_idx').on(t.characterId, t.updatedAt)],
)

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    /** 父消息。外键级联删除：删掉一个节点，整棵子树一起删 */
    parentId: text('parent_id').references((): any => messages.id, { onDelete: 'cascade' }),
    role: text('role').$type<MessageRole>().notNull(),
    content: text('content').notNull().default(''),
    status: text('status').$type<MessageStatus>().notNull().default('done'),
    meta: text('meta', { mode: 'json' }).$type<MessageMeta>().notNull().default({}),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('messages_chat_parent_idx').on(t.chatId, t.parentId)],
)

export const characterLorebooks = sqliteTable(
  'character_lorebooks',
  {
    characterId: text('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    lorebookId: text('lorebook_id')
      .notNull()
      .references(() => lorebooks.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.characterId, t.lorebookId] })],
)

export const chatLorebooks = sqliteTable(
  'chat_lorebooks',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    lorebookId: text('lorebook_id')
      .notNull()
      .references(() => lorebooks.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.lorebookId] })],
)

/** 全局键值配置，比如默认 API 预设、默认人设 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>(),
})

export type CharacterRow = typeof characters.$inferSelect
export type ChatRow = typeof chats.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type ApiPresetRow = typeof apiPresets.$inferSelect
export type PersonaRow = typeof personas.$inferSelect
