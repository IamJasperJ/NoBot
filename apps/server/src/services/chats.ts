import { buildChildrenMap, collectSubtree, findLatestLeaf, siblingOf } from '@nobot/core'
import type {
  ChatDTO,
  ChatPage,
  ChatSummary,
  CreateChatInput,
  ExcludeMessagesInput,
  GroupDTO,
  MessageDTO,
  MessageMeta,
  MessageRole,
  MessageStatus,
  SetVarsInput,
  UpdateChatInput,
} from '@nobot/shared'
import { createChatInput } from '@nobot/shared'
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm'
import { db, getSetting, newId, sqlite } from '../db/client'
import {
  backgrounds,
  type ChatRow,
  characters,
  chatLorebooks,
  chats,
  groupMembers,
  groups,
  messages,
  roomEvents,
  roomUsage,
} from '../db/schema'
import { systemDatabase } from '../db/system-client'
import { rooms } from '../db/system-schema'
import { HttpError, notFound } from '../errors'
import { emitServerEvent } from '../extensions/registry'
import { t } from '../i18n'
import { avatarUrl } from '../lib/files'
import { currentUser } from '../user-context'
import { deleteBackground, getBackgroundSettings, requireBackground } from './backgrounds/backgrounds'
import { abortGeneration, isGenerating } from './generation/generation'
import {
  applyStageParse,
  backfillStage,
  computeStage,
  initialVars,
  resolvePlayPreset,
  resolveStateSchema,
} from './generation/stage'
import { liveHub } from './live/hub'
import { getPlayPreset } from './playPresets'
import { getProfile } from './profiles'
import { quickReplyScope, setQuickReplyScope } from './quick-replies'
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
  if (!msg) throw notFound(t('消息'))
  return msg
}

/** 跑团状态 = 激活路径上每条消息先合并 varsPatch，再合并 varsManual（值为 null 表示删除） */
export function computeVars(
  path: { role: MessageRole; meta: MessageMeta }[],
  base: Record<string, unknown> = {},
): Record<string, unknown> {
  const vars: Record<string, unknown> = { ...base }
  for (const m of path) {
    for (const patch of [m.meta.varsPatch, m.meta.varsManual]) {
      for (const [k, v] of Object.entries(patch ?? {})) {
        if (v === null) delete vars[k]
        else vars[k] = v
      }
    }
  }
  return vars
}

/** 手动修改挂在当前叶子上，切换分支和回放时自然遵循消息路径。 */
export function setVars(chatId: string, input: SetVarsInput) {
  const chat = getChatRow(chatId)
  if (isGenerating(chatId)) throw new HttpError(409, 'GENERATING', t('正在生成，稍后再修改变量'))
  if (!chat.activeLeafId) throw new HttpError(400, 'NO_MESSAGES', t('还没有消息，没法修改变量'))
  if (!resolvePlayPreset(chatId).data.interaction.varEdit)
    throw new HttpError(403, 'VAR_EDIT_DISABLED', t('这个会话的玩法预设不允许手动修改数值'))
  const message = loadMessage(chat.activeLeafId)
  const meta = { ...message.meta, varsManual: { ...message.meta.varsManual, ...input.set } }
  db.update(messages).set({ meta }).where(eq(messages.id, message.id)).run()
  emitServerEvent({ type: 'message:updated', message: loadMessage(message.id) })
  return { vars: computeVars(loadPath(message.id), initialVars(chatId).vars) }
}

// ---------------------------------------------------------------------------

function toSummary(row: ChatRow): ChatSummary {
  return {
    sourceProvider: row.sourceProvider,
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
    quickReplySetIds: quickReplyScope('chat', row.id),
    backgroundId: row.backgroundId,
    backgroundPinned: row.backgroundPinned,
    autoBackground: row.autoBackground,
    personaId: row.personaId,
    activeLeafId: row.activeLeafId,
    profileId: row.profileId,
    apiPresetId: row.apiPresetId,
    promptPresetId: row.promptPresetId,
    playPresetId: row.playPresetId,
    authorNote: row.authorNote,
    authorNoteDepth: row.authorNoteDepth,
    authorNoteRole: row.authorNoteRole,
    lorebookIds: chatLorebookIds(row.id),
    createdAt: row.createdAt,
  }
}

/** 群组信息（会话页需要成员的名字和头像来显示发言人） */
export function loadGroupDTO(groupId: string): GroupDTO {
  const g = db
    .select()
    .from(groups)
    .where(and(eq(groups.id, groupId), isNull(groups.deletedAt)))
    .get()
  if (!g) throw notFound(t('群组'))
  const members = db
    .select({ member: groupMembers, character: characters })
    .from(groupMembers)
    .innerJoin(characters, eq(characters.id, groupMembers.characterId))
    .where(and(eq(groupMembers.groupId, groupId), isNull(characters.deletedAt)))
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
    defaultBackgroundId: g.defaultBackgroundId,
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
  if (!row || !ownerAvailable(row)) throw notFound(t('会话'))
  return row
}

/** 回收站中的主人仍保留会话，但普通读取不能再访问它们。 */
function ownerAvailable(row: ChatRow): boolean {
  if (row.characterId)
    return !!db
      .select({ id: characters.id })
      .from(characters)
      .where(and(eq(characters.id, row.characterId), isNull(characters.deletedAt)))
      .get()
  if (row.groupId)
    return !!db
      .select({ id: groups.id })
      .from(groups)
      .where(and(eq(groups.id, row.groupId), isNull(groups.deletedAt)))
      .get()
  return false
}

export function listChats(filter: { characterId?: string; groupId?: string }): ChatSummary[] {
  return db
    .select({ chat: chats })
    .from(chats)
    .leftJoin(characters, eq(characters.id, chats.characterId))
    .leftJoin(groups, eq(groups.id, chats.groupId))
    .where(
      and(
        filter.characterId ? eq(chats.characterId, filter.characterId) : undefined,
        !filter.characterId && filter.groupId ? eq(chats.groupId, filter.groupId) : undefined,
        or(
          and(eq(characters.id, chats.characterId), isNull(characters.deletedAt)),
          and(eq(groups.id, chats.groupId), isNull(groups.deletedAt)),
        ),
      ),
    )
    .orderBy(desc(chats.updatedAt))
    .all()
    .map(({ chat }) => toSummary(chat))
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
    const character = db
      .select()
      .from(characters)
      .where(and(eq(characters.id, characterId), isNull(characters.deletedAt)))
      .get()
    if (!character) throw notFound(t('角色'))
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
  // 开场白、开启指令前的旧消息还没解析过舞台指令，打开会话时补上（只在加载最新一页时做）
  if (!opts.before && !generating) backfillStage(chatId)
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)

  let start = chat.activeLeafId
  if (opts.before) {
    const before = db.select().from(messages).where(eq(messages.id, opts.before)).get()
    if (!before || before.chatId !== chatId) throw notFound(t('消息'))
    start = before.parentId
  }

  // 多取一条，用来判断是否还有更早的消息
  const page = loadPath(start, limit + 1)
  const hasMore = page.length > limit
  const play = resolvePlayPreset(chatId)
  return {
    chat: toDTO(chat),
    group: chat.groupId ? loadGroupDTO(chat.groupId) : null,
    messages: hasMore ? page.slice(1) : page,
    hasMore,
    generating,
    // 状态变量要看整条路径；翻旧页时前端不用它
    vars: opts.before ? {} : computeVars(loadPath(chat.activeLeafId), initialVars(chatId).vars),
    stage: computeStage(chatId, loadPath(chat.activeLeafId)),
    playPresetId: play.id,
    stateSchema: play.data.directives.enabled ? resolveStateSchema(chatId, play.data) : {},
  }
}

export function updateChat(chatId: string, input: UpdateChatInput): ChatDTO {
  getChatRow(chatId)
  if (input.profileId != null) getProfile(input.profileId)
  if (input.playPresetId != null) getPlayPreset(input.playPresetId)
  if (input.backgroundId != null) requireBackground(input.backgroundId)
  const { lorebookIds, quickReplySetIds, ...rest } = input
  db.transaction((tx) => {
    if (quickReplySetIds) setQuickReplyScope('chat', chatId, quickReplySetIds)
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

export async function deleteChat(chatId: string) {
  // 正文删除后目录也删除；房主账号删除由系统库外键级联删除目录和 ACL。
  const room = systemDatabase()
    .select()
    .from(rooms)
    .where(and(eq(rooms.chatId, chatId), eq(rooms.hostUserId, currentUser().id)))
    .get()
  if (room) {
    abortGeneration(chatId)
    systemDatabase().delete(rooms).where(eq(rooms.id, room.id)).run()
    for (const id of liveHub.topicUsers(`room:${room.id}`)) {
      liveHub.publishToUser(id, {
        type: 'room.removed',
        topic: `user:${id}`,
        data: { roomId: room.id, reason: 'room_closed' },
      })
      liveHub.disconnectUserFromTopic(id, `room:${room.id}`)
    }
    db.transaction(() => {
      db.delete(roomEvents).where(eq(roomEvents.roomId, room.id)).run()
      db.delete(roomUsage).where(eq(roomUsage.roomId, room.id)).run()
    })
  }
  const disposable: string[] = []
  db.transaction(() => {
    const owned = db.select().from(backgrounds).where(eq(backgrounds.chatId, chatId)).all()
    const globalId = getBackgroundSettings().globalId
    const referenced = new Set(
      db
        .select({ id: chats.id, backgroundId: chats.backgroundId })
        .from(chats)
        .all()
        .filter((chat) => chat.id !== chatId)
        .map((chat) => chat.backgroundId),
    )
    for (const background of owned) {
      if (background.id !== globalId && !referenced.has(background.id)) disposable.push(background.id)
    }
    // 先解除归属，文件清理失败也不能阻止会话删除。
    db.update(backgrounds).set({ chatId: null }).where(eq(backgrounds.chatId, chatId)).run()
    db.delete(chats).where(eq(chats.id, chatId)).run()
  })
  await Promise.all(
    disposable.map(async (id) => {
      try {
        await deleteBackground(id)
      } catch (error) {
        console.error('删除会话背景失败', id, error)
      }
    }),
  )
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
  if (!node) throw notFound(t('消息'))
  const children = buildChildrenMap(nodes)
  const target = siblingOf(children, node, direction)
  if (!target) return null

  const leaf = findLatestLeaf(children, target.id)
  db.update(chats).set({ activeLeafId: leaf, updatedAt: Date.now() }).where(eq(chats.id, chatId)).run()
  emitServerEvent({ type: 'message:updated', message: loadMessage(leaf) })
  return leaf
}

/**
 * 从某条消息开分支：把根到这条消息的路径复制成一个新会话（只复制这一条路径，不带其他 swipe）。
 * 会话设置（人设、预设、作者注释、世界书）一并复制。
 */
export function branchChat(chatId: string, messageId: string): ChatDTO {
  const chat = getChatRow(chatId)
  const target = db.select().from(messages).where(eq(messages.id, messageId)).get()
  if (!target || target.chatId !== chatId) throw notFound(t('消息'))
  const path = loadPath(messageId)
  const now = Date.now()
  const newChatId = newId()

  db.transaction((tx) => {
    tx.insert(chats)
      .values({
        ...chat,
        id: newChatId,
        title: t('{title}（分支）', { title: chat.title }),
        activeLeafId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    const parentId = copyPath(tx, newChatId, null, path)
    tx.update(chats).set({ activeLeafId: parentId }).where(eq(chats.id, newChatId)).run()
    for (const lorebookId of chatLorebookIds(chatId)) {
      tx.insert(chatLorebooks).values({ chatId: newChatId, lorebookId }).run()
    }
  })
  return toDTO(getChatRow(newChatId))
}

export function editMessage(messageId: string, content: string, reasoning?: string): MessageDTO {
  const row = db.select().from(messages).where(eq(messages.id, messageId)).get()
  if (!row) throw notFound(t('消息'))
  if (row.status === 'streaming') throw new HttpError(409, 'BUSY', t('这条消息还在生成中，不能编辑'))
  const meta = applyStageParse(row.chatId, row, content)
  if (reasoning !== undefined) {
    if (reasoning.trim()) meta.reasoning = reasoning
    else delete meta.reasoning
  }
  db.update(messages).set({ content, meta }).where(eq(messages.id, messageId)).run()
  return loadMessage(messageId)
}

/**
 * 删除消息及其整棵子树（外键级联）。
 * 如果当前激活的叶子在被删的子树里，就把激活位置移到父节点那一支的最新叶子。
 */
export function deleteMessage(messageId: string) {
  const row = db.select().from(messages).where(eq(messages.id, messageId)).get()
  if (!row) throw notFound(t('消息'))
  if (row.status === 'streaming') throw new HttpError(409, 'BUSY', t('这条消息还在生成中，请先停止生成'))
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
  emitServerEvent({ type: 'message:deleted', chatId: row.chatId, messageIds: [...removed] })
}

/** 图片任务未完成时多留一格，通用接口仍只能修改图片序号。 */
export function updateMessageImageIndex(messageId: string, imageIndex: number): MessageDTO {
  db.transaction(() => {
    const message = loadMessage(messageId)
    const extra = ['pending', 'error'].includes(message.meta.imageGen?.status ?? '') ? 1 : 0
    if (!Number.isInteger(imageIndex) || imageIndex < 0 || imageIndex >= (message.meta.images?.length ?? 0) + extra)
      throw new HttpError(400, 'VALIDATION', t('图片序号超出范围'))
    db.update(messages)
      .set({ meta: { ...message.meta, imageIndex } })
      .where(eq(messages.id, messageId))
      .run()
  })
  const saved = loadMessage(messageId)
  emitServerEvent({ type: 'message:updated', message: saved })
  return saved
}

/** 复制路径时统一保留消息快照；调用方负责开启事务和切换激活叶子。 */
function copyPath(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  chatId: string,
  parentId: string | null,
  path: MessageDTO[],
): string | null {
  for (const m of path) {
    const id = newId()
    tx.insert(messages)
      .values({
        id,
        chatId,
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
  return parentId
}

/** 切到某个节点所在的分支。exact 为 true 时激活叶子就是这个节点本身（读档），否则是它子树里最新的叶子（同 swipe） */
export function activateMessage(chatId: string, messageId: string, exact = false): string {
  getChatRow(chatId)
  const nodes = loadTree(chatId)
  if (!nodes.some((m) => m.id === messageId)) throw notFound(t('消息'))
  if (isGenerating(chatId)) throw new HttpError(409, 'GENERATING', t('正在生成，稍后再切换'))
  const leafId = exact ? messageId : findLatestLeaf(buildChildrenMap(nodes), messageId)
  db.update(chats).set({ activeLeafId: leafId, updatedAt: Date.now() }).where(eq(chats.id, chatId)).run()
  emitServerEvent({ type: 'message:updated', message: loadMessage(leafId) })
  return leafId
}

export function moveMessage(chatId: string, messageId: string, direction: 'up' | 'down'): string {
  const chat = getChatRow(chatId)
  const path = loadPath(chat.activeLeafId)
  let index = path.findIndex((m) => m.id === messageId)
  if (index < 0) throw new HttpError(400, 'NOT_ON_PATH', t('只能移动当前分支上的消息'))
  if (direction === 'down') {
    if (index === path.length - 1) throw new HttpError(400, 'CANNOT_MOVE', t('已经是最后一条'))
    index++
  }
  const x = path[index]!
  const p = path[index - 1]
  if (!p) throw new HttpError(400, 'CANNOT_MOVE', t('已经是第一条'))
  if ([x, p].some((m) => m.role === 'tool' || m.meta.toolCalls))
    throw new HttpError(400, 'CANNOT_MOVE', t('工具调用和结果不能移动'))
  if (isGenerating(chatId) || [x, p].some((m) => m.status === 'streaming'))
    throw new HttpError(409, 'GENERATING', t('正在生成，稍后再移动'))
  return db.transaction((tx) => {
    const leafId = copyPath(tx, chatId, p.parentId, [x, p, ...path.slice(index + 1)])!
    tx.update(chats).set({ activeLeafId: leafId, updatedAt: Date.now() }).where(eq(chats.id, chatId)).run()
    return leafId
  })
}

export function excludeMessages(chatId: string, input: ExcludeMessagesInput): MessageDTO[] {
  getChatRow(chatId)
  const rows = db.select().from(messages).where(eq(messages.chatId, chatId)).all()
  const byId = new Map(rows.map((m) => [m.id, m]))
  for (const id of input.messageIds) if (!byId.has(id)) throw notFound(t('消息'))
  const children = buildChildrenMap(rows)
  const selected = new Set(input.messageIds)
  for (const id of input.messageIds) {
    const message = byId.get(id)!
    let caller = message
    // 结果只向上寻找连续工具链的发起者，不能跨过下一轮普通消息。
    if (message.role === 'tool' && message.meta.toolCallId) {
      while (caller.parentId) {
        const parent = byId.get(caller.parentId)
        if (!parent) break
        caller = parent
        if (caller.role !== 'tool') break
      }
      if (caller.role !== 'assistant' || !caller.meta.toolCalls?.some((c) => c.id === message.meta.toolCallId)) continue
    }
    if (caller.role !== 'assistant' || !caller.meta.toolCalls) continue
    selected.add(caller.id)
    const calls = new Set(caller.meta.toolCalls.map((c) => c.id))
    // 从某条结果切换时沿它所在的链补齐；从发起者切换时沿最新子链，不扩散到兄弟备选。
    const chain = new Map(loadPath(message.id).map((m) => [m.parentId, m.id]))
    let current = caller
    while (true) {
      const kids = children.get(current.id)
      const next = kids?.find((m) => m.id === chain.get(current.id)) ?? kids?.at(-1)
      if (next?.role !== 'tool') break
      if (next.meta.toolCallId && calls.has(next.meta.toolCallId)) selected.add(next.id)
      current = next
    }
  }
  db.transaction((tx) => {
    for (const id of selected) {
      const row = byId.get(id)!
      const meta = { ...row.meta }
      if (input.excluded ? meta.excluded === true : !Object.hasOwn(meta, 'excluded')) continue
      if (input.excluded) meta.excluded = true
      else delete meta.excluded
      tx.update(messages).set({ meta }).where(eq(messages.id, id)).run()
    }
  })
  return [...selected].map(loadMessage).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}
