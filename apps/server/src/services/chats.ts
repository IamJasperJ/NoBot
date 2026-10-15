import { buildChildrenMap, collectSubtree, findLatestLeaf, siblingOf } from '@ai-parter/core'
import type {
  ChatDTO,
  ChatPage,
  ChatSummary,
  CreateChatInput,
  MessageDTO,
  MessageRole,
  MessageStatus,
  UpdateChatInput,
} from '@ai-parter/shared'
import { createChatInput } from '@ai-parter/shared'
import { desc, eq } from 'drizzle-orm'
import { db, getSetting, newId, sqlite } from '../db/client'
import { type ChatRow, chats, messages } from '../db/schema'
import { HttpError, notFound } from '../errors'
import { getCharacterRow } from './characters'

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

// ---------------------------------------------------------------------------

function toSummary(row: ChatRow): ChatSummary {
  return { id: row.id, characterId: row.characterId, title: row.title, updatedAt: row.updatedAt }
}

function toDTO(row: ChatRow): ChatDTO {
  return {
    ...toSummary(row),
    personaId: row.personaId,
    activeLeafId: row.activeLeafId,
    apiPresetId: row.apiPresetId,
    authorNote: row.authorNote,
    authorNoteDepth: row.authorNoteDepth,
    createdAt: row.createdAt,
  }
}

export function getChatRow(id: string): ChatRow {
  const row = db.select().from(chats).where(eq(chats.id, id)).get()
  if (!row) throw notFound('会话')
  return row
}

export function listChats(characterId?: string): ChatSummary[] {
  const q = db.select().from(chats)
  const rows = characterId
    ? q.where(eq(chats.characterId, characterId)).orderBy(desc(chats.updatedAt)).all()
    : q.orderBy(desc(chats.updatedAt)).all()
  return rows.map(toSummary)
}

/**
 * 新建会话。开场白和所有备选开场白都作为根节点插入（互为 swipe），
 * 激活用户选的那一个。
 */
export function createChat(input: CreateChatInput): ChatDTO {
  const { characterId, greetingIndex } = createChatInput.parse(input)
  const character = getCharacterRow(characterId)
  const greetings = [character.firstMes, ...character.alternateGreetings].filter((g) => g.trim())

  const now = Date.now()
  const chatId = newId()
  const date = new Date(now).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  db.transaction((tx) => {
    tx.insert(chats)
      .values({
        id: chatId,
        characterId,
        personaId: getSetting<string>('defaultPersonaId') ?? null,
        title: `${character.name} · ${date}`,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    let activeId: string | null = null
    for (const [i, content] of greetings.entries()) {
      const id = newId()
      tx.insert(messages).values({ id, chatId, parentId: null, role: 'assistant', content, createdAt: now }).run()
      if (i === Math.min(greetingIndex, greetings.length - 1)) activeId = id
    }
    tx.update(chats).set({ activeLeafId: activeId }).where(eq(chats.id, chatId)).run()
  })

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
  return { chat: toDTO(chat), messages: hasMore ? page.slice(1) : page, hasMore, generating }
}

export function updateChat(chatId: string, input: UpdateChatInput): ChatDTO {
  getChatRow(chatId)
  db.update(chats)
    .set({ ...input, updatedAt: Date.now() })
    .where(eq(chats.id, chatId))
    .run()
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
