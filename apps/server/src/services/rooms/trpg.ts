import { createHash } from 'node:crypto'
import { rollDice } from '@nobot/core'
import type {
  CharacterSheet,
  ChoiceCheckInput,
  MessageDTO,
  MessageMeta,
  RoomChoiceState,
  RoomInitiativeState,
  RoomRoundState,
  roomInitiativeInput,
  roomRollInput,
  roomWhisperInput,
} from '@nobot/shared'
import { eq } from 'drizzle-orm'
import type { z } from 'zod'
import { db, getSetting, newId, setSetting } from '../../db/client'
import { chats, messages } from '../../db/schema'
import { HttpError } from '../../errors'
import { t } from '../../i18n'
import { currentUser } from '../../user-context'
import { getChatRow, loadMessage, loadPath } from '../chats'
import { isGenerating } from '../generation/generation'
import { logError } from '../logs'
import { notify } from '../social'
import { performCheck } from '../trpg/trpg'
import { roomMessage } from './dto'
import { notifyRoom } from './extensions'
import {
  asHost,
  charactersForRoom,
  checkQuota,
  checkWritable,
  event,
  findRoom,
  members,
  membership,
  publish,
  type Room,
  requireRole,
} from './index'
import { cleanMessageText } from './input'
import { broadcastTurn, persistTurn, rescheduleRoom, sendRoomMessage, triggerTurn, turnState } from './turns'

function save(room: Room, type: string, value: RoomRoundState | RoomInitiativeState | RoomChoiceState) {
  const data = db.transaction(() => {
    setSetting(`${type}:${room.id}${'messageId' in value ? `:${value.messageId}` : ''}`, value)
    const payload = type === 'room.round' ? roundSnapshot(room) : 'messageId' in value ? choiceView(room, value) : value
    return event(room, type, currentUser().id, { ...payload })
  })
  publish(data)
}

/** 活动时间持久化，重启不能把已离开的玩家重新算作在场。 */
export function roomActivity(room: Room, userId: string, now = Date.now()) {
  asHost(room, () => {
    const times = getSetting<Record<string, number>>(`room-activity:${room.id}`) ?? {}
    setSetting(`room-activity:${room.id}`, { ...times, [userId]: now })
    const round = getSetting<RoomRoundState>(`room.round:${room.id}`)
    if (round?.members[userId] === 'away') {
      round.members[userId] = 'pending'
      save(room, 'room.round', round)
    }
    armRound(room, now)
  })
}
const roundTimers = new Map<string, ReturnType<typeof setTimeout>>()
function armRound(room: Room, now = Date.now()) {
  clearTimeout(roundTimers.get(room.id))
  roundTimers.delete(room.id)
  if (room.status !== 'active') return
  let dueAt: number | undefined
  if (room.asyncMode) dueAt = roundSnapshot(room, now).deadline
  else {
    const times = getSetting<Record<string, number>>(`room-activity:${room.id}`) ?? {}
    const deadlines = members(room.id)
      .filter((m) => m.role === 'player')
      .map((m) => (times[m.userId] ?? m.joinedAt) + 120001)
      .filter((deadline) => deadline > now)
    if (deadlines.length) dueAt = Math.min(...deadlines)
  }
  if (dueAt === undefined || dueAt <= now) return
  const timer = setTimeout(
    () => {
      if (roundTimers.get(room.id) !== timer) return
      roundTimers.delete(room.id)
      try {
        const latest = findRoom(room.id)
        if (latest?.status !== 'active' || latest.chatId !== room.chatId) return
        asHost(latest, () => reconcileRound(latest))
      } catch {
        /* 额度或房间生命周期变化不应中断其他房间的定时器。 */
      }
    },
    Math.min(2147483647, dueAt - now),
  )
  timer.unref()
  roundTimers.set(room.id, timer)
}
export function reconcileRound(room: Room, now = Date.now()) {
  if (room.status !== 'active') return
  const snapshot = roundSnapshot(room, now)
  const previous = getSetting<RoomRoundState>(`room.round:${room.id}`)
  if (JSON.stringify(previous) !== JSON.stringify(snapshot)) save(room, 'room.round', snapshot)
  notifyPending(room, snapshot)
  armRound(room, now)
  maybeResolveReady(room, now)
}
export function registerChoices(room: Room, message: MessageDTO) {
  if (message.meta.stage?.choices?.length) choiceSnapshot(room.id, message.id)
}
/** 启动时按持久化截止时间恢复，关闭浏览器不影响房间状态机。 */
export function resumeRoom(room: Room) {
  stopRoomTimers(room.id)
  if (room.status !== 'active') return
  restoreChoices(room)
  reconcileRound(room)
  notifyInitiative(room, initiativeSnapshot(room))
  startAiEntry(room)
}
function activePlayers(room: Room, now: number) {
  const times = getSetting<Record<string, number>>(`room-activity:${room.id}`) ?? {}
  return members(room.id).filter(
    (m) => m.role === 'player' && (room.asyncMode || now - (times[m.userId] ?? m.joinedAt) <= 120000),
  )
}
export function roundSnapshot(room: Room, now = Date.now()): RoomRoundState {
  const stored = getSetting<RoomRoundState>(`room.round:${room.id}`)
  const saved: RoomRoundState = stored ?? {
    round: 1,
    members: {},
  }
  if (!room.asyncMode || !room.roundDeadlineHours) delete saved.deadline
  else if (room.status === 'active' && !saved.deadline) saved.deadline = now + room.roundDeadlineHours * 3600000
  if (room.status === 'active' && saved.deadline && saved.deadline <= now)
    for (const m of members(room.id))
      if (
        m.role === 'player' &&
        ['pending', 'away'].includes(
          room.asyncMode && saved.members[m.userId] === 'away' ? 'pending' : (saved.members[m.userId] ?? 'pending'),
        )
      )
        saved.members[m.userId] = 'passed'
  if (!stored && room.status === 'active') setSetting(`room.round:${room.id}`, saved)
  const active = new Set(activePlayers(room, now).map((m) => m.userId))
  return {
    round: saved.round,
    deadline: saved.deadline,
    members: Object.fromEntries(
      members(room.id)
        .filter((m) => m.role !== 'spectator')
        .map((m) => [
          m.userId,
          m.role === 'player' && !active.has(m.userId)
            ? 'away'
            : room.asyncMode && saved.members[m.userId] === 'away'
              ? 'pending'
              : (saved.members[m.userId] ?? 'pending'),
        ]),
    ),
  }
}
export function initiativeSnapshot(room: Room): RoomInitiativeState {
  return getSetting<RoomInitiativeState>(`room.initiative:${room.id}`) ?? { order: [], current: 0 }
}
/** 新玩家与回归玩家排到末尾，保留当前行动者和现有次序。 */
export function appendInitiativeMember(room: Room, userId: string) {
  if (room.turnMode !== 'initiative' || membership(room.id, userId).member.role !== 'player') return
  asHost(room, () => {
    const state = initiativeSnapshot(room)
    if (state.order.some((entry) => entry.kind === 'member' && entry.id === userId)) return
    state.order.push({ kind: 'member', id: userId })
    save(room, 'room.initiative', state)
  })
}
/** 移除当前项时接续原下一项；末项离开则进入下一轮。 */
export function removeInitiativeMember(room: Room, userId: string) {
  const state = initiativeSnapshot(room)
  const index = state.order.findIndex((entry) => entry.kind === 'member' && entry.id === userId)
  if (index < 0) return
  state.order.splice(index, 1)
  if (index < state.current) state.current--
  else if (state.current >= state.order.length) {
    state.current = 0
    nextRound(room)
  }
  save(room, 'room.initiative', state)
  notifyInitiative(room, state)
  startAiEntry(room)
}
export function assertInitiative(room: Room, userId: string) {
  if (room.turnMode !== 'initiative') return
  const state = initiativeSnapshot(room)
  if (!state.order.length || ['owner', 'gm'].includes(membership(room.id, userId).member.role)) return
  const entry = state.order[state.current]
  if (entry?.kind !== 'member' || entry.id !== userId) throw new HttpError(409, 'NOT_YOUR_TURN', t('还没有轮到你行动'))
}
const initiativeTimers = new Map<string, ReturnType<typeof setTimeout>>()
function startAiEntry(room: Room) {
  clearTimeout(initiativeTimers.get(room.id))
  initiativeTimers.delete(room.id)
  if (room.turnMode !== 'initiative' || room.status !== 'active') return
  const state = initiativeSnapshot(room),
    entry = state.order[state.current]
  if (entry?.kind !== 'character') return
  // complete 回调执行时生成锁尚未释放，下一次事件循环再申请锁。
  const timer = setTimeout(() => {
    if (initiativeTimers.get(room.id) !== timer) return
    initiativeTimers.delete(room.id)
    const currentRoom = findRoom(room.id)
    if (currentRoom?.status !== 'active' || currentRoom.turnMode !== 'initiative' || currentRoom.chatId !== room.chatId)
      return
    try {
      asHost(currentRoom, () => {
        const latest = initiativeSnapshot(currentRoom)
        if (
          latest.current !== state.current ||
          latest.order[latest.current]?.kind !== 'character' ||
          latest.order[latest.current]?.id !== entry.id ||
          turnState(room.id).running
        )
          return
        triggerTurn(
          room.id,
          members(room.id).find((m) => m.userId === turnState(room.id).actorId)?.userId ?? currentRoom.hostUserId,
          false,
          { mode: 'trigger', speakerId: entry.id },
        )
      })
    } catch {
      /* 房主不可用或生成被拦截时保留当前项，主持可重试或跳过。 */
    }
  }, 0)
  timer.unref()
  initiativeTimers.set(room.id, timer)
}
export function nextRound(room: Room) {
  const state = roundSnapshot(room)
  const next: RoomRoundState = {
    round: state.round + 1,
    ...(room.asyncMode && room.roundDeadlineHours ? { deadline: Date.now() + room.roundDeadlineHours * 3600000 } : {}),
    members: Object.fromEntries(
      members(room.id)
        .filter((m) => m.role !== 'spectator')
        .map((m) => [m.userId, 'pending']),
    ),
  }
  save(room, 'room.round', next)
  notifyPending(room, next)
  armRound(room)
  return roundSnapshot(room)
}
export function advanceInitiative(room: Room) {
  const state = initiativeSnapshot(room)
  if (!state.order.length) return state
  state.current++
  if (state.current >= state.order.length) {
    state.current = 0
    nextRound(room)
  }
  save(room, 'room.initiative', state)
  notifyInitiative(room, state)
  startAiEntry(room)
  return state
}
export function afterAiTurn(room: Room) {
  if (room.turnMode === 'initiative') advanceInitiative(room)
  else nextRound(room)
}
export function maybeResolveReady(room: Room, now = Date.now()) {
  if (room.status !== 'active' || room.turnMode !== 'host' || !room.autoResolveWhenReady || turnState(room.id).running)
    return
  const players = activePlayers(room, now),
    state = roundSnapshot(room, now)
  if (
    players.length &&
    players.every((m) => ['done', 'passed'].includes(state.members[m.userId] ?? 'pending')) &&
    turnState(room.id).pending.length
  )
    triggerTurn(
      room.id,
      players.find((m) => m.userId === turnState(room.id).actorId)?.userId ?? players[0]!.userId,
      false,
    )
}
export function readyRoom(id: string, state: 'pending' | 'done' | 'passed', now = Date.now()) {
  const { room, member } = membership(id)
  checkWritable(room, member.userId)
  roomActivity(room, member.userId, now)
  return asHost(room, () => {
    if (state === 'passed' && room.turnMode === 'initiative') {
      assertInitiative(room, member.userId)
      advanceInitiative(room)
    }
    const snapshot = roundSnapshot(room, now)
    snapshot.members[member.userId] = state
    save(room, 'room.round', snapshot)
    maybeResolveReady(room, now)
    return snapshot
  })
}
export function skipRound(id: string, userId: string) {
  const { room, member } = requireRole(id, ['owner', 'gm'])
  checkWritable(room, member.userId)
  if (membership(id, userId).member.role === 'spectator')
    throw new HttpError(400, 'ROUND_SPECTATOR', t('旁观者不参与轮次'))
  return asHost(room, () => {
    const snapshot = roundSnapshot(room)
    snapshot.members[userId] = 'passed'
    save(room, 'room.round', snapshot)
    maybeResolveReady(room)
    return snapshot
  })
}
export function advanceRound(id: string) {
  const { room, member } = requireRole(id, ['owner', 'gm'])
  checkWritable(room, member.userId)
  return asHost(room, () => nextRound(room))
}
export function setInitiative(id: string, input: z.infer<typeof roomInitiativeInput>) {
  const { room, member } = requireRole(id, ['owner', 'gm'])
  checkWritable(room, member.userId)
  return asHost(room, () => {
    const playerIds = new Set(
      members(id)
        .filter((m) => m.role !== 'spectator')
        .map((m) => m.userId),
    )
    const characterIds = new Set(charactersForRoom(room).map((m) => m.id))
    const unique = new Set(input.order.map((e) => `${e.kind}:${e.id}`))
    if (
      unique.size !== input.order.length ||
      input.order.some((e) => !(e.kind === 'member' ? playerIds : characterIds).has(e.id))
    )
      throw new HttpError(400, 'INITIATIVE_INVALID_MEMBER', t('先攻顺序只能包含不重复的在场玩家、主持或角色'))
    if (
      !Number.isInteger(input.current ?? 0) ||
      (input.current ?? 0) < 0 ||
      (input.current ?? 0) >= Math.max(1, input.order.length)
    )
      throw new HttpError(400, 'INITIATIVE_INVALID_CURRENT', t('当前先攻位置超出顺序范围'))
    if (turnState(id).running) throw new HttpError(409, 'GENERATING', t('房间正在生成回复'))
    const state = { order: input.order, current: input.current ?? 0 }
    save(room, 'room.initiative', state)
    notifyInitiative(room, state)
    startAiEntry(room)
    return state
  })
}
export function skipInitiative(id: string) {
  const { room, member } = requireRole(id, ['owner', 'gm'])
  checkWritable(room, member.userId)
  return asHost(room, () => {
    if (turnState(id).running) throw new HttpError(409, 'GENERATING', t('房间正在生成回复'))
    return advanceInitiative(room)
  })
}

function visibility(
  room: Room,
  authorId: string,
  level: 'public' | 'gm' | 'blind' | 'self',
): NonNullable<MessageMeta['visibility']> {
  const gmIds = members(room.id)
    .filter((m) => ['owner', 'gm'].includes(m.role))
    .map((m) => m.userId)
  return {
    level,
    userIds: [
      ...new Set([
        ...(level === 'public'
          ? members(room.id).map((m) => m.userId)
          : level === 'self'
            ? [authorId]
            : level === 'blind'
              ? gmIds
              : [authorId, ...gmIds]),
      ]),
    ],
  }
}
/** 骰点和私信只插入节点，不进入待回应队列，也不会启动 AI。 */
function append(room: Room, actorId: string, content: string, meta: MessageMeta, role: 'system' | 'user') {
  const state = turnState(room.id),
    id = newId(),
    now = Date.now()
  const data = db.transaction(() => {
    db.insert(messages)
      .values({
        id,
        chatId: room.chatId,
        parentId: state.running
          ? (state.queued.at(-1) ?? getChatRow(room.chatId).activeLeafId)
          : getChatRow(room.chatId).activeLeafId,
        role,
        content,
        meta,
        createdAt: now,
      })
      .run()
    if (state.running) state.queued.push(id)
    else db.update(chats).set({ activeLeafId: id, updatedAt: now }).where(eq(chats.id, room.chatId)).run()
    persistTurn(room.id, state)
    const message = loadMessage(id)
    return { message, event: event(room, 'room.message', actorId, { action: 'created', message }, id) }
  })
  publish(data.event)
  broadcastTurn(room)
  return data.message
}
export function rollRoom(id: string, input: z.infer<typeof roomRollInput>, random = Math.random) {
  const { room, member } = membership(id)
  checkWritable(room, member.userId)
  return asHost(room, () => {
    const value = rollDice(input.expression, random)
    if (value === null || !Number.isFinite(value)) throw new HttpError(400, 'INVALID_DICE', t('掷骰表达式无效'))
    const result = `${input.expression} = ${value}${input.reason ? ` (${input.reason})` : ''}`
    const message = append(
      room,
      member.userId,
      result,
      {
        author: { userId: member.userId, name: member.personaName },
        name: member.personaName,
        visibility: visibility(room, member.userId, input.visibility),
        excluded: input.visibility === 'self',
      },
      'system',
    )
    const projected = roomMessage(message, member.userId, room.hostUserId)
    return { result: projected.content, message: projected }
  })
}
export function checkRoom(
  id: string,
  input: ChoiceCheckInput & { visibility?: 'public' | 'gm' | 'blind' | 'self' },
  random = Math.random,
) {
  const { room, member } = membership(id)
  checkWritable(room, member.userId)
  return asHost(room, () => {
    // 不信任访客指定的角色，检定固定使用自己的人设与玩家属性。
    const check = {
      ...performCheck(room.chatId, input, undefined, random, {
        name: member.personaName,
        prefix: `player:${member.userId}`,
        sheet: getSetting<CharacterSheet | null>(`room-sheet:${id}:${member.userId}`) ?? null,
        characterId: null,
      }),
      who: member.personaName,
    }
    const level = input.visibility ?? 'public'
    const message = append(
      room,
      member.userId,
      '',
      {
        author: { userId: member.userId, name: member.personaName },
        check,
        visibility: visibility(room, member.userId, level),
        excluded: level === 'self',
      },
      'user',
    )
    const dto = roomMessage(message, member.userId, room.hostUserId)
    return dto.meta.check ?? { hidden: true }
  })
}
export function whisperRoom(id: string, input: z.infer<typeof roomWhisperInput>) {
  const { room, member } = membership(id)
  if (member.role === 'spectator') throw new HttpError(403, 'WHISPER_SPECTATOR_SENDER', t('旁观者不能发送私信'))
  checkWritable(room, member.userId)
  if (input.to === member.userId) throw new HttpError(400, 'WHISPER_SELF', t('不能给自己发送私信'))
  const target = input.to === 'gm' ? undefined : members(id).find((m) => m.userId === input.to)
  if (input.to !== 'gm' && !target) throw new HttpError(400, 'WHISPER_RECIPIENT_NOT_MEMBER', t('收件人不在此房间中'))
  if (target?.role === 'spectator') throw new HttpError(400, 'WHISPER_SPECTATOR', t('旁观者不能接收私信'))
  if (member.role === 'player' && input.to !== 'gm')
    throw new HttpError(400, 'WHISPER_PLAYERS_FORBIDDEN', t('玩家只能向主持发送私信'))
  const recipients =
    input.to === 'gm'
      ? members(id)
          .filter((m) => ['owner', 'gm'].includes(m.role))
          .map((m) => m.userId)
      : [target!.userId]
  return asHost(room, () => {
    const duplicate = db
      .select()
      .from(messages)
      .where(eq(messages.chatId, room.chatId))
      .all()
      .find((m) => m.meta.author?.userId === member.userId && m.meta.clientMessageId === input.clientMessageId)
    if (duplicate) return roomMessage(loadMessage(duplicate.id), member.userId, room.hostUserId)
    const message = append(
      room,
      member.userId,
      cleanMessageText(input.text),
      {
        channel: 'whisper',
        excluded: true,
        author: { userId: member.userId, name: member.personaName },
        name: member.personaName,
        clientMessageId: input.clientMessageId,
        visibility: { level: 'whisper', userIds: [...new Set([member.userId, ...recipients])] },
      },
      'user',
    )
    for (const userId of recipients.filter((userId) => userId !== member.userId))
      notify(userId, 'room.whisper', member.userId, { roomId: id })
    return roomMessage(message, member.userId, room.hostUserId)
  })
}

interface SavedChoice extends RoomChoiceState {
  optionFingerprint?: string
  resultMessageId?: string
}

const voteTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; deadline: number }>()
function voting(room: Room) {
  return room.status === 'active' && room.choiceMode === 'vote'
}
function choiceSource(room: Room, messageId: string) {
  const message = loadPath(messageId, 1)[0]
  if (message?.chatId !== room.chatId || message.role !== 'assistant' || message.meta.excluded) return
  const choices = message.meta.stage?.choices
  if (choices?.length) return { message, choices }
}
function options(room: Room, messageId: string) {
  const source = choiceSource(room, messageId)
  if (!source) throw new HttpError(400, 'CHOICE_UNAVAILABLE', t('此消息没有可用选项'))
  return source
}

/** 结算是持久的；同一分支尚未收到回复时可以重试，已继续的分支不重复开回合。 */
function needsChoiceReply(room: Room, state: SavedChoice) {
  if (!state.closed || !state.resultMessageId) return false
  const path = loadPath(getChatRow(room.chatId).activeLeafId)
  const result = path.findIndex((m) => m.id === state.resultMessageId && !m.meta.excluded)
  return (
    result >= 0 &&
    !path
      .slice(result + 1)
      .some(
        (m) =>
          (m.role === 'assistant' &&
            !m.meta.imageGen &&
            (m.status === 'done' || (m.status === 'aborted' && m.content.trim()))) ||
          (m.role === 'user' && !m.meta.excluded) ||
          !!m.meta.choice?.counts,
      )
  )
}

function choiceView(room: Room, state: SavedChoice): RoomChoiceState {
  const { optionFingerprint: _options, resultMessageId: _result, replyPending: _pending, ...view } = state
  return needsChoiceReply(room, state) ? { ...view, replyPending: true } : view
}
function loadChoice(room: Room, messageId: string, now = Date.now()) {
  const key = `room.choice:${room.id}:${messageId}`
  const saved = getSetting<SavedChoice>(key)
  if (saved?.closed) return saved
  const { message, choices } = options(room, messageId)
  const indexKey = `room-choices:${room.id}`
  const known = getSetting<string[]>(indexKey) ?? []
  const optionFingerprint = createHash('sha256')
    .update(JSON.stringify(choices.map((choice) => [choice.text, choice.check?.skill, choice.check?.dc])))
    .digest('hex')
  const state: SavedChoice = saved ?? {
    messageId,
    votes: {},
    picks: [],
    closed: false,
    winner: null,
    deadline: now + room.voteTimeoutSeconds * 1000,
    counts: choices.map(() => 0),
    optionFingerprint,
  }
  let changed = !saved
  if (saved) {
    const edited = saved.optionFingerprint !== undefined && saved.optionFingerprint !== optionFingerprint
    const votes = edited
      ? {}
      : Object.fromEntries(
          Object.entries(saved.votes).filter(([, index]) => Number.isInteger(index) && !!choices[index]),
        )
    const counts = choices.map(() => 0)
    for (const index of Object.values(votes)) counts[index] = (counts[index] ?? 0) + 1
    if (
      saved.optionFingerprint !== optionFingerprint ||
      Object.keys(saved.votes).length !== Object.keys(votes).length ||
      saved.counts.length !== counts.length ||
      counts.some((count, index) => count !== saved.counts[index])
    ) {
      state.votes = votes
      state.counts = counts
      state.optionFingerprint = optionFingerprint
      if (edited)
        state.deadline = Math.min(now, message.meta.edits?.at(-1)?.createdAt ?? now) + room.voteTimeoutSeconds * 1000
      changed = true
    }
  }
  if (!changed && known.includes(messageId)) return state
  db.transaction(() => {
    if (changed) setSetting(key, state)
    if (!known.includes(messageId)) setSetting(indexKey, [...known, messageId])
  })
  return state
}
export function choiceSnapshot(id: string, messageId: string, now = Date.now()): RoomChoiceState {
  const { room } = membership(id)
  return asHost(room, () => {
    const state = loadChoice(room, messageId, now)
    armVote(room, state, now)
    return choiceView(room, state)
  })
}
export function restoreChoices(room: Room, now = Date.now()) {
  if (!voting(room)) return
  for (const messageId of getSetting<string[]>(`room-choices:${room.id}`) ?? []) {
    const state = getSetting<SavedChoice>(`room.choice:${room.id}:${messageId}`)
    if (state && !state.closed && choiceSource(room, messageId)) armVote(room, loadChoice(room, messageId, now), now)
  }
}
function choiceCheck(room: Room, actor: string, check: ChoiceCheckInput | undefined, random = Math.random) {
  if (!check) return undefined
  const member = membership(room.id, actor).member
  return {
    ...performCheck(room.chatId, check, undefined, random, {
      name: member.personaName,
      prefix: `player:${actor}`,
      sheet: getSetting<CharacterSheet | null>(`room-sheet:${room.id}:${actor}`) ?? null,
      characterId: null,
    }),
    who: member.personaName,
  }
}
function sendChoice(room: Room, messageId: string, index: number, actor = currentUser().id) {
  const option = options(room, messageId).choices[index]
  if (!option) throw new HttpError(400, 'CHOICE_INDEX_INVALID', t('选项序号无效'))
  const check = choiceCheck(room, actor, option.check)
  return sendRoomMessage(
    room.id,
    { text: option.text, channel: 'ic', clientMessageId: `choice:${messageId}:${actor}` },
    { ...(check ? { check } : {}), choice: { messageId, index } },
    actor,
  )
}
function armVote(room: Room, state: RoomChoiceState, now = Date.now(), retryDelay = 0) {
  const key = `${room.id}:${state.messageId}`
  const scheduled = voteTimers.get(key)
  if (state.closed || !voting(room)) {
    clearTimeout(scheduled?.timer)
    voteTimers.delete(key)
    return
  }
  // 读取房间详情不能把已有的重试定时器改成立即执行。
  if (scheduled?.deadline === state.deadline) return
  clearTimeout(scheduled?.timer)
  const timer = setTimeout(
    () => {
      if (voteTimers.get(key)?.timer !== timer) return
      voteTimers.delete(key)
      const currentRoom = findRoom(room.id)
      if (!currentRoom || currentRoom.chatId !== room.chatId || !voting(currentRoom)) return
      try {
        asHost(currentRoom, () => {
          if (!choiceSource(currentRoom, state.messageId)) return
          const latest = loadChoice(currentRoom, state.messageId)
          if (latest.closed) return
          if (latest.deadline !== state.deadline) {
            armVote(currentRoom, latest)
            return
          }
          try {
            closeChoice(room.id, latest.messageId)
          } catch (error) {
            // 生成锁结束后可以重试；模式、房间状态和无效选项由恢复流程重新判断。
            if (error instanceof HttpError && error.code === 'GENERATING' && !latest.closed)
              armVote(currentRoom, latest, Date.now(), 1000)
            else logError(t('自动结算房间投票失败'), error)
          }
        })
      } catch (error) {
        logError(t('自动结算房间投票失败'), error)
      }
    },
    Math.max(retryDelay, state.deadline - now),
  )
  timer.unref()
  voteTimers.set(key, { timer, deadline: state.deadline })
}
export function pickRoomChoice(
  id: string,
  messageId: string,
  index: number,
  now = Date.now(),
  messageVersion?: number,
) {
  const { room, member } = membership(id)
  if (member.role === 'spectator') throw new HttpError(403, 'CHOICE_SPECTATOR', t('旁观者不能参与选项投票'))
  checkWritable(room, member.userId)
  roomActivity(room, member.userId, now)
  return asHost(room, () => {
    const { message, choices } = options(room, messageId)
    if (messageVersion !== undefined && messageVersion !== (message.meta.version ?? 0))
      throw new HttpError(409, 'CHOICE_CHANGED', t('选项已更新，请重新选择'))
    if (!choices[index]) throw new HttpError(400, 'CHOICE_INDEX_INVALID', t('选项编号超出范围'))
    if (room.choiceMode === 'gm') {
      if (member.role === 'player') throw new HttpError(403, 'CHOICE_GM_ONLY', t('此房间仅允许主持选择选项'))
      const state = loadChoice(room, messageId, now)
      if (state.closed) throw new HttpError(409, 'CHOICE_CLOSED', t('选项投票已结束'))
      const message = sendChoice(room, messageId, index, member.userId)
      state.closed = true
      state.winner = index
      state.picks = [member.userId]
      save(room, 'room.choice', state)
      return message
    }
    const state = loadChoice(room, messageId, now)
    armVote(room, state, now)
    if (state.closed || (room.choiceMode === 'vote' && now >= state.deadline))
      throw new HttpError(409, 'CHOICE_CLOSED', t('选项投票已结束'))
    if (room.choiceMode === 'each') {
      if (state.picks.includes(member.userId)) throw new HttpError(409, 'ALREADY_PICKED', t('你已经选择过此选项组'))
      const message = sendChoice(room, messageId, index, member.userId)
      state.picks.push(member.userId)
      if (activePlayers(room, now).every((m) => state.picks.includes(m.userId))) state.closed = true
      save(room, 'room.choice', state)
      const round = roundSnapshot(room, now)
      round.members[member.userId] = 'done'
      save(room, 'room.round', round)
      if (activePlayers(room, now).every((m) => state.picks.includes(m.userId))) {
        if (room.turnMode === 'host') maybeResolveReady(room, now)
        else rescheduleRoom(id)
      }
      return message
    }
    if (member.role !== 'player') throw new HttpError(403, 'CHOICE_PLAYERS_ONLY', t('主持不能参与玩家投票'))
    if (state.votes[member.userId] !== undefined)
      throw new HttpError(409, 'VOTE_CHANGE_NOT_ALLOWED', t('投票后不能更改选择'))
    state.votes[member.userId] = index
    state.counts[index] = (state.counts[index] ?? 0) + 1
    save(room, 'room.choice', state)
    armVote(room, state)
    const all = activePlayers(room, now).every((m) => state.votes[m.userId] !== undefined)
    const max = Math.max(...state.counts)
    if (all && state.counts.filter((n) => n === max).length === 1) return closeChoiceAsHost(room, messageId)
    return choiceView(room, state)
  })
}
function closeChoiceAsHost(room: Room, messageId: string) {
  return asHost(room, () => closeChoice(room.id, messageId))
}
function requestChoiceReply(room: Room, state: SavedChoice) {
  if (!needsChoiceReply(room, state) || turnState(room.id).running || isGenerating(room.chatId)) return
  try {
    triggerTurn(room.id, room.hostUserId, false)
  } catch (error) {
    // 已提交的投票结果仍然有效，房主或主持可以重试同一次回复。
    logError(t('投票结算后无法启动 AI 回复'), error)
  }
}
export function closeChoice(id: string, messageId: string, winner?: number, random = Math.random) {
  const { room, member } = membership(id)
  if (!['owner', 'gm'].includes(member.role))
    throw new HttpError(403, 'CHOICE_CLOSE_FORBIDDEN', t('只有房主或主持可以结束投票'))
  checkWritable(room, currentUser().id)
  if (room.choiceMode !== 'vote') throw new HttpError(409, 'CHOICE_NOT_VOTING', t('此房间当前未启用投票模式'))
  return asHost(room, () => {
    const state = loadChoice(room, messageId)
    if (state.closed) {
      requestChoiceReply(room, state)
      return choiceView(room, state)
    }
    const max = Math.max(...state.counts)
    if (winner === undefined && !Object.keys(state.votes).length) {
      db.transaction(() => {
        append(room, room.hostUserId, t('投票已结束，无人投票'), {}, 'system')
        state.closed = true
        state.winner = null
        save(room, 'room.choice', state)
      })
      armVote(room, state)
      return choiceView(room, state)
    }
    const tied = state.counts.flatMap((count, index) => (count === max ? [index] : []))
    const selected = winner ?? tied[Math.floor(random() * tied.length)]!
    const option = options(room, messageId).choices[selected]
    if (!option || (winner !== undefined && state.counts[selected] !== max))
      throw new HttpError(400, 'CHOICE_WINNER_INVALID', t('获胜选项无效，请选择得票最多的选项'))
    if (turnState(id).running || isGenerating(room.chatId))
      throw new HttpError(409, 'GENERATING', t('房间正在生成回复'))
    checkQuota(room, room.hostUserId)
    db.transaction(() => {
      const content = t('投票结果：{option}。票数：{counts}。{tie}', {
        option: option.text,
        counts: state.counts.join(', '),
        tie: tied.length > 1 ? t('出现平票，已在平票选项中随机选择') : '',
      })
      const voters = Object.keys(state.votes)
      const voter =
        voters.length === 1
          ? members(room.id).find(
              (member) =>
                member.userId === voters[0] &&
                member.role === 'player' &&
                member.acceptedRulesVersion === room.rulesVersion,
            )
          : undefined
      const check = choiceCheck(room, voter?.userId ?? room.hostUserId, option.check, random)
      const result = append(
        room,
        room.hostUserId,
        content,
        {
          ...(check ? { check } : {}),
          choice: { messageId, index: selected, counts: state.counts },
        },
        'system',
      )
      state.closed = true
      state.winner = selected
      state.resultMessageId = result.id
      save(room, 'room.choice', state)
    })
    armVote(room, state)
    requestChoiceReply(room, state)
    return choiceView(room, state)
  })
}

function notifyPending(room: Room, state: RoomRoundState) {
  if (room.status !== 'active' || room.turnMode !== 'host') return
  for (const m of members(room.id))
    if (m.role === 'player' && state.members[m.userId] === 'pending')
      notifyRoom(room, m.userId, 'room.your-turn', `your-turn:${room.id}:${state.round}:${m.userId}`)
}
function notifyInitiative(room: Room, state: RoomInitiativeState) {
  if (room.status !== 'active' || room.turnMode !== 'initiative') return
  const entry = state.order[state.current]
  if (entry?.kind === 'member' && members(room.id).some((m) => m.userId === entry.id))
    notifyRoom(room, entry.id, 'room.your-turn', `your-turn:${room.id}:${roundSnapshot(room).round}:${entry.id}`)
}

/** 房间暂停、关闭或更换模式时撤销旧的回合、先攻和投票定时器。 */
export function stopRoomTimers(id: string) {
  clearTimeout(roundTimers.get(id))
  roundTimers.delete(id)
  clearTimeout(initiativeTimers.get(id))
  initiativeTimers.delete(id)
  for (const [key, { timer }] of voteTimers)
    if (key.startsWith(`${id}:`)) {
      clearTimeout(timer)
      voteTimers.delete(key)
    }
}
