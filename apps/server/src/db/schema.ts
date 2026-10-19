import type {
  CharacterSheet,
  GenerationLogSummary,
  GroupActivation,
  GroupGenerationMode,
  LorebookEntryData,
  MessageMeta,
  MessageRole,
  MessageStatus,
  PlayPresetData,
  PresetData,
  PromptRole,
  RegexScript,
  SaveSnapshot,
} from '@nobot/shared'
import { sql } from 'drizzle-orm'
import { type AnySQLiteColumn, index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * 数据库表结构，和设计文档「数据模型」「第二阶段架构」两节对应。
 * 时间统一存毫秒时间戳；id 统一用 ULID（按时间有序的字符串）。
 *
 * 结构复杂、字段会随功能增加的配置（生成预设、世界书条目）整体存成 json，
 * 读出来时用 shared 里的 zod schema parse 补齐默认值：以后加字段不用改表、不用写迁移。
 */

const timestamps = {
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}

export const characters = sqliteTable('characters', {
  deletedAt: integer('deleted_at'),
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
  creator: text('creator').notNull().default(''),
  characterVersion: text('character_version').notNull().default(''),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
  /** 群聊里没被点名时的发言积极度 0–1 */
  talkativeness: real('talkativeness').notNull().default(0.5),
  /** 角色备注（酒馆的 depth_prompt），按深度插入聊天记录 */
  characterNote: text('character_note').notNull().default(''),
  characterNoteDepth: integer('character_note_depth').notNull().default(4),
  characterNoteRole: text('character_note_role').$type<PromptRole>().notNull().default('system'),
  /** 用这个角色新建会话时默认使用的人设 */
  defaultPersonaId: text('default_persona_id'),
  profileId: text('profile_id').references((): AnySQLiteColumn => profiles.id, { onDelete: 'set null' }),
  defaultBackgroundId: text('default_background_id').references((): AnySQLiteColumn => backgrounds.id, {
    onDelete: 'set null',
  }),
  /** 头像文件名（不含目录），没有头像时为空 */
  avatarFile: text('avatar_file'),
  /** 角色卡 data.extensions 里本应用不认识的字段 + 扩展存的角色级数据，导出时写回 */
  extensions: text('extensions', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  /** 导入时的整张卡，原样保存，导出时不丢字段 */
  raw: text('raw', { mode: 'json' }).$type<Record<string, unknown>>(),
  ...timestamps,
})

/** 用户人设，即 {{user}} */
export const personas = sqliteTable('personas', {
  sheet: text('sheet', { mode: 'json' }).$type<CharacterSheet>(),
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  avatarFile: text('avatar_file'),
  /** 人设绑定的世界书 */
  lorebookId: text('lorebook_id').references(() => lorebooks.id, { onDelete: 'set null' }),
  ...timestamps,
})

export const lorebooks = sqliteTable('lorebooks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  /** 全局世界书：所有会话都生效 */
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
    /** 在编辑器里的显示顺序 */
    sort: integer('sort').notNull().default(0),
    /** 条目的全部字段，结构见 shared 的 lorebookEntryDataSchema */
    data: text('data', { mode: 'json' }).$type<LorebookEntryData>().notNull().default(sql`'{}'`),
  },
  (t) => [index('lorebook_entries_book_idx').on(t.lorebookId, t.sort)],
)

/** 内容和模型共同决定缓存；连接也纳入标识，避免同名模型来自不同供应商。 */
export const lorebookVectors = sqliteTable('lorebook_vectors', {
  key: text('key').primaryKey(),
  entryId: text('entry_id')
    .notNull()
    .references(() => lorebookEntries.id, { onDelete: 'cascade' }),
  contentHash: text('content_hash').notNull(),
  model: text('model').notNull(),
  vector: text('vector', { mode: 'json' }).$type<number[]>().notNull(),
})

/** 连接配置：地址、Key、模型 */
export const apiPresets = sqliteTable('api_presets', {
  provider: text('provider').notNull().default('custom'),
  options: text('options', { mode: 'json' }).$type<Record<string, string>>().notNull().default(sql`'{}'`),
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  /** 本地数据库明文保存，接口返回时打码；将来部署到服务器时再加密 */
  apiKey: text('api_key').notNull().default(''),
  headers: text('headers', { mode: 'json' }).$type<Record<string, string>>().notNull().default(sql`'{}'`),
  model: text('model').notNull(),
  vision: text('vision').$type<'auto' | 'yes' | 'no'>().notNull().default('auto'),
  ...timestamps,
})

/** 生成预设：采样参数 + Prompt 管理器 + 辅助提示词 + 行为开关 */
export const promptPresets = sqliteTable('prompt_presets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  data: text('data', { mode: 'json' }).$type<PresetData>().notNull().default(sql`'{}'`),
  ...timestamps,
})

export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  apiPresetId: text('api_preset_id').references(() => apiPresets.id, { onDelete: 'set null' }),
  promptPresetId: text('prompt_preset_id').references(() => promptPresets.id, { onDelete: 'set null' }),
  model: text('model').notNull().default(''),
  regexScripts: text('regex_scripts', { mode: 'json' }).$type<RegexScript[]>(),
  imageConnectionId: text('image_connection_id').references(() => apiPresets.id, { onDelete: 'set null' }),
  promptConnectionId: text('prompt_connection_id').references(() => apiPresets.id, { onDelete: 'set null' }),
  ...timestamps,
})

export const playPresets = sqliteTable('play_presets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  data: text('data', { mode: 'json' }).$type<PlayPresetData>().notNull().default(sql`'{}'`),
  /** 内置预设的标识（chat、companion、galgame、rpg、dnd5e），用来「重置为内置默认」；用户建的预设为空 */
  builtinKey: text('builtin_key'),
  ...timestamps,
})

export const groups = sqliteTable('groups', {
  deletedAt: integer('deleted_at'),
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  activation: text('activation').$type<GroupActivation>().notNull().default('natural'),
  generationMode: text('generation_mode').$type<GroupGenerationMode>().notNull().default('swap'),
  allowSelfResponses: integer('allow_self_responses', { mode: 'boolean' }).notNull().default(false),
  autoMode: integer('auto_mode', { mode: 'boolean' }).notNull().default(false),
  scenarioOverride: text('scenario_override').notNull().default(''),
  defaultBackgroundId: text('default_background_id').references((): AnySQLiteColumn => backgrounds.id, {
    onDelete: 'set null',
  }),
  ...timestamps,
})

export const groupMembers = sqliteTable(
  'group_members',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    characterId: text('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    /** 成员列表里的顺序 */
    position: integer('position').notNull().default(0),
    muted: integer('muted', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.characterId] })],
)

export const backgrounds = sqliteTable('backgrounds', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  // 会话删除前由业务判断删除还是转为公共；其他级联删除也不能连带丢失图片。
  chatId: text('chat_id').references((): AnySQLiteColumn => chats.id, { onDelete: 'set null' }),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  source: text('source').$type<'upload' | 'generated'>().notNull(),
  /** 文件类型，见 BackgroundDTO.mime */
  mime: text('mime').notNull().default('image/webp'),
  createdAt: integer('created_at').notNull(),
})

export const backgroundFolders = sqliteTable('background_folders', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  coverBackgroundId: text('cover_background_id').references(() => backgrounds.id, { onDelete: 'set null' }),
  sort: integer('sort').notNull().default(0),
  ...timestamps,
})

export const backgroundFolderItems = sqliteTable(
  'background_folder_items',
  {
    folderId: text('folder_id')
      .notNull()
      .references(() => backgroundFolders.id, { onDelete: 'cascade' }),
    backgroundId: text('background_id')
      .notNull()
      .references(() => backgrounds.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.folderId, t.backgroundId] })],
)

export const chats = sqliteTable(
  'chats',
  {
    id: text('id').primaryKey(),
    /** 单人会话的角色；群聊为空 */
    characterId: text('character_id').references(() => characters.id, { onDelete: 'cascade' }),
    /** 群聊的群组；单人会话为空 */
    groupId: text('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    backgroundId: text('background_id').references(() => backgrounds.id, { onDelete: 'set null' }),
    backgroundPinned: integer('background_pinned', { mode: 'boolean' }).notNull().default(false),
    autoBackground: text('auto_background', { mode: 'json' })
      .$type<{ lore: boolean; everyN: number }>()
      .notNull()
      .default({ lore: false, everyN: 0 }),
    personaId: text('persona_id').references(() => personas.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    /** 当前分支的叶子节点。不加外键：删除消息时由业务代码负责更新它 */
    activeLeafId: text('active_leaf_id'),
    profileId: text('profile_id').references(() => profiles.id, { onDelete: 'set null' }),
    apiPresetId: text('api_preset_id').references(() => apiPresets.id, { onDelete: 'set null' }),
    promptPresetId: text('prompt_preset_id').references(() => promptPresets.id, { onDelete: 'set null' }),
    playPresetId: text('play_preset_id'),
    authorNote: text('author_note').notNull().default(''),
    authorNoteDepth: integer('author_note_depth').notNull().default(4),
    authorNoteRole: text('author_note_role').$type<PromptRole>().notNull().default('system'),
    /** 会话级变量（保留字段）。跑团状态由 tool 消息的 varsPatch 沿路径累加得到，不存这里 */
    vars: text('vars', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [index('chats_character_idx').on(t.characterId, t.updatedAt), index('chats_group_idx').on(t.groupId)],
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
    /** 角色消息是哪个角色说的。不加外键：角色删除后消息仍保留（显示 meta.name） */
    speakerId: text('speaker_id'),
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
    /** 顺序，第一本是导出时嵌入角色卡的主世界书 */
    position: integer('position').notNull().default(0),
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

/** 模型请求日志（错误查看、查看某条消息当时的 Prompt）。只保留最近若干条 */
export const generationLogs = sqliteTable(
  'generation_logs',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id'),
    messageId: text('message_id'),
    kind: text('kind').$type<GenerationLogSummary['kind']>().notNull(),
    status: text('status').$type<'ok' | 'error' | 'aborted'>().notNull(),
    model: text('model'),
    durationMs: integer('duration_ms'),
    summary: text('summary').notNull().default(''),
    request: text('request', { mode: 'json' }).$type<unknown>(),
    response: text('response', { mode: 'json' }).$type<unknown>(),
    report: text('report', { mode: 'json' }).$type<unknown>(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('generation_logs_created_idx').on(t.createdAt)],
)

/** 全局键值配置，比如默认连接、默认预设、默认人设、世界书设置、扩展设置 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>(),
})

export type CharacterRow = typeof characters.$inferSelect
export type ChatRow = typeof chats.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type ApiPresetRow = typeof apiPresets.$inferSelect
export type PromptPresetRow = typeof promptPresets.$inferSelect
export type PersonaRow = typeof personas.$inferSelect
export type GroupRow = typeof groups.$inferSelect
export type LorebookRow = typeof lorebooks.$inferSelect
export type LorebookEntryRow = typeof lorebookEntries.$inferSelect

/** 立绘保留原图格式，服装只参与检索，不参与文件路径。 */
export const sprites = sqliteTable(
  'sprites',
  {
    id: text('id').primaryKey(),
    characterId: text('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    outfit: text('outfit').notNull().default(''),
    expression: text('expression').notNull(),
    ext: text('ext').$type<'png' | 'webp' | 'gif' | 'jpg'>().notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('sprites_character_outfit_expression_idx').on(t.characterId, t.outfit, t.expression)],
)

export const bookmarks = sqliteTable(
  'bookmarks',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').$type<'bookmark' | 'save'>().notNull().default('bookmark'),
    snapshot: text('snapshot', { mode: 'json' }).$type<SaveSnapshot>(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('bookmarks_chat_created_idx').on(t.chatId, t.createdAt)],
)
