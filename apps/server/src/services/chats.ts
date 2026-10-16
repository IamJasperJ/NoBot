import { buildChildrenMap, collectSubtree, findLatestLeaf, siblingOf } from '@ai-parter/core'
import type {
  ChatDTO,
  ChatPage,
  ChatSummary,
  CreateChatInput,
  GroupDTO,
  MessageDTO,
  MessageMeta,
  MessageRole,
  MessageStatus,
  UpdateChatInput,
} from '@ai-parter/shared'
import { createChatInput } from '@ai-parter/shared'
import { asc, desc, eq, inArray } from 'drizzle-orm'
import { db, getSetting, newId, sqlite } from '../db/client'
import { type ChatRow, characters, chatLorebooks, chats, groupMembers, groups, messages } from '../db/schema'
import { HttpError, notFound } from '../errors'
import { emitServerEvent } from '../extensions/registry'
import { avatarUrl } from '../lib/files'
import { SETTING_KEYS } from './settings'

// ---------------------------------------------------------------------------
// 消息树查询：用递归 CTE 从叶子沿 parent_id 往上走，一条 SQL 拿到整条路径。
// swipe 序号用子查询现算：同一个父节点下 id 不大于自己的兄弟有几个。
// 有 (chat_id, parent_id) 索引，5000 条消息也是毫秒级。
// ---------------------------------------------------------------------------

interface PathRow {
  id: string
  chat_id: string
  parent_id: string | null
  role: MessageRole
  content: string
  status: MessageStatus
  meta: string
  speaker_id: string | null
  created_at: number
  swipe_index: number
  swipe_count: number
}

// 用到时才预编译：模块加载时数据库迁移可能还没跑，表还不存在
const pathQuery = () =>
  sqlite.query<PathRow, { start: string; limit: number }>(`
  WITH RECURSIVE path(id, parent_id, depth) AS (
    SELECT id, parent_id, 0 FROM messages WHERE id = $start
    UNION ALL
    SELECT m.id, m.parent_id, p.depth + 1
    FROM messages m JOIN path p ON m.id = p.parent_id
    WHERE p.depth + 1 < $limit
  )
  SELECT m.*,
    (SELECT count(*) FROM messages s WHERE s.chat_id = m.chat_id AND s.parent_id IS m.parent_id AND s.id <= m.id) AS swipe_index,
    (SELECT count(*) FROM messages s WHERE s.chat_id = m.chat_id AND s.parent_id IS m.parent_id) AS swipe_count
  FROM path JOIN messages m ON m.id = path.id
  ORDER BY path.depth DESC
`)

function rowToDTO(r: PathRow): MessageDTO {
  return {
    id: r.id,
    chatId: r.chat_id,
    parentId: r.parent_id,
    role: r.role,
    content: r.content,
    status: r.status,
    meta: JSON.parse(r.meta),
    speakerId: r.speaker_id,
    createdAt: r.created_at,
    swipeIndex: r.swipe_index,
    swipeCount: r.swipe_count,
  }
}

/** 从 startId 往上取最多 limit 条消息，按从旧到新排列 */
export function loadPath(startId: string | null, limit = Number.MAX_SAFE_INTEGER): MessageDTO[] {
  if (!startId) return []
  return pathQuery().all({ start: startId, limit }).map(rowToDTO)
}

/** 取单条消息（带 swipe 信息） */
export function loadMessage(id: string): MessageDTO {
  const msg = loadPath(id, 1)[0]
  if (!msg) throw notFound('消息')
  return msg
}

/** 跑团状态 = 激活路径上所有 tool 消息的 varsPatch 依次合并（值为 null 表示删除） */
export function computeVars(path: { role: MessageRole; meta: MessageMeta }[]): Record<string, unknown> {
  const vars: Record<string, unknown> = {}
  for (const m of path) {
    if (m.role !== 'tool' || !m.meta.varsPatch) continue
    for (const [k, v] of Object.entries(m.meta.varsPatch)) {
      if (v === null) delete vars[k]
      else vars[k] = v
    }
  }
  return vars
}

// ---------------------------------------------------------------------------

function toSummary(row: ChatRow): ChatSummary {
  return {
    id: row.id,
    characterId: row.characterId,
    groupId: row.groupId,
    title: row.title,
    updatedAt: row.updatedAt,
  }
}

function chatLorebookIds(chatId: string): string[] {
  return db
    .select({ id: chatLorebooks.lorebookId })
    .from(chatLorebooks)
    .where(eq(chatLorebooks.chatId, chatId))
    .all()
    .map((r) => r.id)
}

function toDTO(row: ChatRow): ChatDTO {
  return {
    ...toSummary(row),
    personaId: row.personaId,
    activeLeafId: row.activeLeafId,
    apiPresetId: row.apiPresetId,
    promptPresetId: row.promptPresetId,
    authorNote: row.authorNote,
    authorNoteDepth: row.authorNoteDepth,
    authorNoteRole: row.authorNoteRole,
    lorebookIds: chatLorebookIds(row.id),
    createdAt: row.createdAt,
  }
}

/** 群组信息（会话页需要成员的名字和头像来显示发言人） */
export function loadGroupDTO(groupId: string): GroupDTO {
  const g = db.select().from(groups).where(eq(groups.id, groupId)).get()
  if (!g) throw notFound('群组')
  const members = db
    .select({ member: groupMembers, character: characters })
    .from(groupMembers)
    .innerJoin(characters, eq(characters.id, groupMembers.characterId))
    .where(eq(groupMembers.groupId, groupId))
    .orderBy(asc(groupMembers.position))
    .all()
  return {
    id: g.id,
    name: g.name,
    activation: g.activation,
    generationMode: g.generationMode,
    allowSelfResponses: g.allowSelfResponses,
    autoMode: g.autoMode,
    scenarioOverride: g.scenarioOverride,
    members: members.map(({ member, character }) => ({
      characterId: character.id,
      name: character.name,
      avatarUrl: avatarUrl(character.avatarFile, character.updatedAt),
      muted: member.muted,
      talkativeness: character.talkativeness,
    })),
    updatedAt: g.updatedAt,
  }
}

export function getChatRow(id: string): ChatRow {
  const row = db.select().from(chats).where(eq(chats.id, id)).get()
  if (!row) throw notFound('会话')
  return row
}

export function listChats(filter: { characterId?: string; groupId?: string }): ChatSummary[] {
  const where = filter.characterId
    ? eq(chats.characterId, filter.characterId)
    : filter.groupId
      ? eq(chats.groupId, filter.groupId)
      : undefined
  return db.select().from(chats).where(where).orderBy(desc(chats.updatedAt)).all().map(toSummary)
}

const shortDate = (now: number) =>
  new Date(now).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/**
 * 新建会话。
 * - 单人会话：开场白和所有备选开场白都作为根节点插入（互为 swipe），激活用户选的那一个
 * - 群聊：每个没被静音的成员的开场白依次接成一条链（和酒馆一样，开场每人打一声招呼）
 * 人设：角色设置了默认人设就用它，否则用全局默认人设。
 */
export function createChat(input: CreateChatInput): ChatDTO {
  const { characterId, groupId, greetingIndex } = createChatInput.parse(input)
  const now = Date.now()
  const chatId = newId()
  const defaultPersona = getSetting<string>(SETTING_KEYS.defaultPersonaId) ?? null

  if (characterId) {
    const character = db.select().from(characters).where(eq(characters.id, characterId)).get()
    if (!character) throw notFound('角色')
    const greetings = [character.firstMes, ...character.alternateGreetings].filter((g) => g.trim())
    db.transaction((tx) => {
      tx.insert(chats)
        .values({
          id: chatId,
          characterId,
          personaId: character.defaultPersonaId ?? defaultPersona,
          title: `${character.name} · ${shortDate(now)}`,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      let activeId: string | null = null
      for (const [i, content] of greetings.entries()) {
        const id = newId()
        tx.insert(messages)
          .values({
            id,
            chatId,
            parentId: null,
            role: 'assistant',
            content,
            speakerId: characterId,
            meta: { name: character.name },
            createdAt: now,
          })
          .run()
        if (i === Math.min(greetingIndex, greetings.length - 1)) activeId = id
      }
      tx.update(chats).set({ activeLeafId: activeId }).where(eq(chats.id, chatId)).run()
    })
  } else if (groupId) {
    const group = loadGroupDTO(groupId)
    const active = group.members.filter((m) => !m.muted)
    const rows = db
      .select()
      .from(characters)
      .where(
        inArray(
          characters.id,
          active.map((m) => m.characterId),
        ),
      )
      .all()
    // 按成员列表顺序
    const ordered = active.map((m) => rows.find((r) => r.id === m.characterId)).filter((r) => r !== undefined)
    db.transaction((tx) => {
      tx.insert(chats)
        .values({
          id: chatId,
          groupId,
          personaId: defaultPersona,
          title: `${group.name} · ${shortDate(now)}`,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      let parentId: string | null = null
      for (const c of ordered) {
        if (!c.firstMes.trim()) continue
        const id = newId()
        tx.insert(messages)
          .values({
            id,
            chatId,
            parentId,
            role: 'assistant',
            content: c.firstMes,
            speakerId: c.id,
            meta: { name: c.name },
            createdAt: now,
          })
          .run()
        parentId = id
      }
      tx.update(chats).set({ activeLeafId: parentId }).where(eq(chats.id, chatId)).run()
    })
  }

  emitServerEvent({ type: 'chat:created', chatId })
  return toDTO(getChatRow(chatId))
}

/**
 * 打开会话：返回激活路径上的一页消息。
 * before 为空时取最新的 limit 条；否则取 before 之前（更旧）的 limit 条。
 */
export function getChatPage(chatId: string, opts: { before?: string; limit?: number }, generating: boolean): ChatPage {
  const chat = getChatRow(chatId)
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)

  let start = chat.activeLeafId
  if (opts.before) {
    const before = db.select().from(messages).where(eq(messages.id, opts.before)).get()
    if (!before || before.chatId !== chatId) throw notFound('消息')
    start = before.parentId
  }

  // 多取一条，用来判断是否还有更早的消息
  const page = loadPath(start, limit + 1)
  const hasMore = page.length > limit
  return {
    chat: toDTO(chat),
    group: chat.groupId ? loadGroupDTO(chat.groupId) : null,
    messages: hasMore ? page.slice(1) : page,
    hasMore,
    generating,
    // 状态变量要看整条路径；翻旧页时前端不用它
    vars: opts.before ? {} : computeVars(loadPath(chat.activeLeafId)),
  }
}

export function updateChat(chatId: string, input: UpdateChatInput): ChatDTO {
  getChatRow(chatId)
  const { lorebookIds, ...rest } = input
  db.transaction((tx) => {
    tx.update(chats)
      .set({ ...rest, updatedAt: Date.now() })
      .where(eq(chats.id, chatId))
      .run()
    if (lorebookIds) {
      tx.delete(chatLorebooks).where(eq(chatLorebooks.chatId, chatId)).run()
      for (const lorebookId of new Set(lorebookIds)) tx.insert(chatLorebooks).values({ chatId, lorebookId }).run()
    }
  })
  return toDTO(getChatRow(chatId))
}

export function deleteChat(chatId: string) {
  db.delete(chats).where(eq(chats.id, chatId)).run()
}

/** 读出整个会话的树结构（只要 id 和 parent_id，很轻） */
function loadTree(chatId: string) {
  return db
    .select({ id: messages.id, parentId: messages.parentId })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .all()
}

/**
 * 左右切换 swipe：把激活叶子换成目标兄弟节点子树里最新的叶子。
 * 没有兄弟可切时返回 null，前端据此决定是否重新生成。
 */
export function swipe(chatId: string, messageId: string, direction: -1 | 1): string | null {
  const nodes = loadTree(chatId)
  const node = nodes.find((n) => n.id === messageId)
  if (!node) throw notFound('消息')
  const children = buildChildrenMap(nodes)
  const target = siblingOf(children, node, direction)
  if (!target) return null

  const leaf = findLatestLeaf(children, target.id)
  db.update(chats).set({ activeLeafId: leaf, updatedAt: Date.now() }).where(eq(chats.id, chatId)).run()
  return leaf
}

/**
 * 从某条消息开分支：把根到这条消息的路径复制成一个新会话（只复制这一条路径，不带其他 swipe）。
 * 会话设置（人设、预设、作者注释、世界书）一并复制。
 */
export function branchChat(chatId: string, messageId: string): ChatDTO {
  const chat = getChatRow(chatId)
  const target = db.select().from(messages).where(eq(messages.id, messageId)).get()
  if (!target || target.chatId !== chatId) throw notFound('消息')
  const path = loadPath(messageId)
  const now = Date.now()
  const newChatId = newId()

  db.transaction((tx) => {
    tx.insert(chats)
      .values({
        ...chat,
        id: newChatId,
        title: `${chat.title}（分支）`,
        activeLeafId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    let parentId: string | null = null
    for (const m of path) {
      const id = newId()
      tx.insert(messages)
        .values({
          id,
          chatId: newChatId,
          parentId,
          role: m.role,
          content: m.content,
          status: m.status === 'streaming' ? 'aborted' : m.status,
          meta: m.meta,
          speakerId: m.speakerId,
          createdAt: m.createdAt,
        })
        .run()
      parentId = id
    }
    tx.update(chats).set({ activeLeafId: parentId }).where(eq(chats.id, newChatId)).run()
    for (const lorebookId of chatLorebookIds(chatId)) {
      tx.insert(chatLorebooks).values({ chatId: newChatId, lorebookId }).run()
    }
  })
  return toDTO(getChatRow(newChatId))
}

export function editMessage(messageId: string, content: string): MessageDTO {
  const row = db.select().from(messages).where(eq(messages.id, messageId)).get()
  if (!row) throw notFound('消息')
  if (row.status === 'streaming') throw new HttpError(409, 'BUSY', '这条消息还在生成中，不能编辑')
  db.update(messages).set({ content }).where(eq(messages.id, messageId)).run()
  return loadMessage(messageId)
}

/**
 * 删除消息及其整棵子树（外键级联）。
 * 如果当前激活的叶子在被删的子树里，就把激活位置移到父节点那一支的最新叶子。
 */
export function deleteMessage(messageId: string) {
  const row = db.select().from(messages).where(eq(messages.id, messageId)).get()
  if (!row) throw notFound('消息')
  if (row.status === 'streaming') throw new HttpError(409, 'BUSY', '这条消息还在生成中，请先停止生成')
  const chat = getChatRow(row.chatId)
  const nodes = loadTree(row.chatId)
  const removed = new Set(collectSubtree(buildChildrenMap(nodes), messageId))

  db.transaction((tx) => {
    tx.delete(messages).where(eq(messages.id, messageId)).run()

    if (chat.activeLeafId && removed.has(chat.activeLeafId)) {
      const remaining = buildChildrenMap(nodes.filter((n) => !removed.has(n.id)))
      let leaf: string | null = null
      if (row.parentId) leaf = findLatestLeaf(remaining, row.parentId)
      else {
        const root = remaining.get(null)?.at(-1)
        leaf = root ? findLatestLeaf(remaining, root.id) : null
      }
      tx.update(chats).set({ activeLeafId: leaf, updatedAt: Date.now() }).where(eq(chats.id, row.chatId)).run()
    }
  })
}
