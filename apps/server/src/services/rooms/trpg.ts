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
import { getChatRow, loadMessage } from '../chats'
import { isGenerating } from '../generation/generation'
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
  members,
  membership,
  publish,
  type Room,
  refused,
  requireRole,
  roomRow,
} from './index'
import { broadcastTurn, persistTurn, rescheduleRoom, sendRoomMessage, triggerTurn, turnState } from './turns'

function save(room: Room, type: string, value: RoomRoundState | RoomInitiativeState | RoomChoiceState) {
  const data = db.transaction(() => {
    setSetting(`${type}:${room.id}${'messageId' in value ? `:${value.messageId}` : ''}`, value)
    const payload = type === 'room.round' ? roundSnapshot(room) : value
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
  if (room.asyncMode) {
    const snapshot = roundSnapshot(room, now)
    if (snapshot.deadline && snapshot.deadline > now) {
      const timer = setTimeout(
        () => {
          try {
            const latest = roomRow(room.id)
            asHost(latest, () => reconcileRound(latest))
          } catch {
            /* 房间删除或停用后不再唤醒。 */
          }
        },
        Math.min(2147483647, snapshot.deadline - now),
      )
      timer.unref()
      roundTimers.set(room.id, timer)
    }
    return
  }
  const times = getSetting<Record<string, number>>(`room-activity:${room.id}`) ?? {}
  const deadlines = members(room.id)
    .filter((m) => m.role === 'player')
    .map((m) => (times[m.userId] ?? m.joinedAt) + 120001)
    .filter((deadline) => deadline > now)
  if (!deadlines.length) {
    roundTimers.delete(room.id)
    return
  }
  const timer = setTimeout(
    () => {
      roundTimers.delete(room.id)
      try {
        const latest = roomRow(room.id)
        asHost(latest, () => reconcileRound(latest))
      } catch {
        /* 额度或房间生命周期变化不应中断其他房间的定时器。 */
      }
    },
    Math.max(1, Math.min(...deadlines) - now),
  )
  timer.unref()
  roundTimers.set(room.id, timer)
}
export function reconcileRound(room: Room, now = Date.now()) {
  const snapshot = roundSnapshot(room, now)
  const previous = getSetting<RoomRoundState>(`room.round:${room.id}`)
  if (JSON.stringify(previous) !== JSON.stringify(snapshot)) save(room, 'room.round', snapshot)
  notifyPending(room, snapshot)
  maybeResolveReady(room, now)
  armRound(room, now)
}
export function registerChoices(room: Room, message: MessageDTO) {
  if (message.meta.stage?.choices?.length) choiceSnapshot(room.id, message.id)
}
/** 启动时按持久化截止时间恢复，关闭浏览器不影响房间状态机。 */
export function resumeRoom(room: Room) {
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
  const saved = getSetting<RoomRoundState>(`room.round:${room.id}`) ?? {
    round: 1,
    members: {},
    ...(room.asyncMode && room.roundDeadlineHours ? { deadline: now + room.roundDeadlineHours * 3600000 } : {}),
  }
  if (room.asyncMode && room.roundDeadlineHours && !saved.deadline)
    saved.deadline = now + room.roundDeadlineHours * 3600000
  if (!room.roundDeadlineHours) delete saved.deadline
  if (room.asyncMode && saved.deadline && saved.deadline <= now)
    for (const m of members(room.id))
      if (
        m.role === 'player' &&
        ['pending', 'away'].includes(
          room.asyncMode && saved.members[m.userId] === 'away' ? 'pending' : (saved.members[m.userId] ?? 'pending'),
        )
      )
        saved.members[m.userId] = 'passed'
  if (!getSetting<RoomRoundState>(`room.round:${room.id}`)) setSetting(`room.round:${room.id}`, saved)
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
export function assertInitiative(room: Room, userId: string) {
  if (room.turnMode !== 'initiative') return
  const state = initiativeSnapshot(room)
  const entry = state.order[state.current]
  if (entry?.kind !== 'member' || entry.id !== userId) throw new HttpError(409, 'NOT_YOUR_TURN', t('还没有轮到你行动'))
}
function startAiEntry(room: Room) {
  if (room.turnMode !== 'initiative' || room.status !== 'active') return
  const state = initiativeSnapshot(room),
    entry = state.order[state.current]
  if (entry?.kind !== 'character') return
  // complete 回调执行时生成锁尚未释放，下一次事件循环再申请锁。
  setTimeout(
    () =>
      asHost(room, () => {
        const latest = initiativeSnapshot(roomRow(room.id))
        if (
          latest.current !== state.current ||
          latest.order[latest.current]?.id !== entry.id ||
          turnState(room.id).running
        )
          return
        try {
          triggerTurn(
            room.id,
            members(room.id).find((m) => m.userId === turnState(room.id).actorId)?.userId ?? room.hostUserId,
            false,
            { mode: 'trigger', speakerId: entry.id },
          )
        } catch {
          /* 额度或锁拒绝时保留当前项，主持可重试或跳过。 */
        }
      }),
    0,
  ).unref()
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
  if (room.turnMode !== 'host' || !room.autoResolveWhenReady || turnState(room.id).running) return
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
  const { room } = requireRole(id, ['owner', 'gm'])
  if (membership(id, userId).member.role === 'spectator') throw refused()
  return asHost(room, () => {
    const snapshot = roundSnapshot(room)
    snapshot.members[userId] = 'passed'
    save(room, 'room.round', snapshot)
    maybeResolveReady(room)
    return snapshot
  })
}
export function advanceRound(id: string) {
  const { room } = requireRole(id, ['owner', 'gm'])
  return asHost(room, () => nextRound(room))
}
export function setInitiative(id: string, input: z.infer<typeof roomInitiativeInput>) {
  const { room } = requireRole(id, ['owner', 'gm'])
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
      input.order.some((e) => !(e.kind === 'member' ? playerIds : characterIds).has(e.id)) ||
      (input.current ?? 0) >= Math.max(1, input.order.length)
    )
      throw refused()
    if (turnState(id).running) throw new HttpError(409, 'GENERATING', t('房间正在生成回复'))
    const state = { order: input.order, current: input.current ?? 0 }
    save(room, 'room.initiative', state)
    notifyInitiative(room, state)
    startAiEntry(room)
    return state
  })
}
export function skipInitiative(id: string) {
  const { room } = requireRole(id, ['owner', 'gm'])
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
  checkWritable(room, member.userId)
  const recipients =
    input.to === 'gm'
      ? members(id)
          .filter((m) => ['owner', 'gm'].includes(m.role))
          .map((m) => m.userId)
      : [membership(id, input.to).member.userId]
  if (member.role === 'player' && input.to !== 'gm') throw refused()
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
      input.text,
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

const voteTimers = new Map<string, ReturnType<typeof setTimeout>>()
function options(room: Room, messageId: string) {
  const message = loadMessage(messageId)
  if (message.chatId !== room.chatId || message.role !== 'assistant' || !message.meta.stage?.choices?.length)
    throw refused()
  return message.meta.stage.choices
}
export function choiceSnapshot(id: string, messageId: string, now = Date.now()): RoomChoiceState {
  const { room } = membership(id)
  return asHost(room, () => {
    const choices = options(room, messageId)
    const state = getSetting<RoomChoiceState>(`room.choice:${id}:${messageId}`) ?? {
      messageId,
      votes: {},
      picks: [],
      closed: false,
      winner: null,
      deadline: now + room.voteTimeoutSeconds * 1000,
      counts: choices.map(() => 0),
    }
    setSetting(`room.choice:${id}:${messageId}`, state)
    const known = getSetting<string[]>(`room-choices:${id}`) ?? []
    if (!known.includes(messageId)) setSetting(`room-choices:${id}`, [...known, messageId])
    if (room.choiceMode === 'vote') armVote(room, state)
    return state
  })
}
export function restoreChoices(room: Room, now = Date.now()) {
  for (const messageId of getSetting<string[]>(`room-choices:${room.id}`) ?? []) {
    const state = getSetting<RoomChoiceState>(`room.choice:${room.id}:${messageId}`)
    if (state && !state.closed) armVote(room, state, now)
  }
}
function sendChoice(room: Room, messageId: string, index: number, counts?: number[], actor = currentUser().id) {
  const option = options(room, messageId)[index]
  if (!option) throw refused()
  // 单人投票保留该玩家的人设；多人共同决议才使用中立的房间署名。
  const collective = counts && counts.reduce((sum, count) => sum + count, 0) > 1
  const member = membership(room.id, actor).member
  const check = option.check
    ? {
        ...performCheck(room.chatId, option.check, undefined, Math.random, {
          name: member.personaName,
          prefix: `player:${actor}`,
          sheet: getSetting<CharacterSheet | null>(`room-sheet:${room.id}:${actor}`) ?? null,
          characterId: null,
        }),
        who: collective ? room.name : member.personaName,
      }
    : undefined
  return sendRoomMessage(
    room.id,
    { text: option.text, channel: 'ic', clientMessageId: `choice:${messageId}:${counts ? 'room' : actor}` },
    {
      ...(check ? { check } : {}),
      choice: { messageId, index, counts },
      ...(collective ? { author: { userId: room.id, name: room.name }, name: room.name } : {}),
    },
    actor,
  )
}
function armVote(room: Room, state: RoomChoiceState, now = Date.now(), retryDelay = 0) {
  const key = `${room.id}:${state.messageId}`
  clearTimeout(voteTimers.get(key))
  if (state.closed) {
    voteTimers.delete(key)
    return
  }
  const timer = setTimeout(
    () =>
      asHost(room, () => {
        voteTimers.delete(key)
        try {
          closeChoice(room.id, state.messageId)
        } catch {
          // 锁、暂停或额度暂时阻塞时保留原截止时间，稍后重试而不是永久遗失定时任务。
          const latest = getSetting<RoomChoiceState>(`room.choice:${room.id}:${state.messageId}`)
          if (latest && !latest.closed) armVote(roomRow(room.id), latest, Date.now(), 1000)
        }
      }),
    Math.max(retryDelay, state.deadline - now),
  )
  timer.unref()
  voteTimers.set(key, timer)
}
export function pickRoomChoice(id: string, messageId: string, index: number, now = Date.now()) {
  const { room, member } = membership(id)
  checkWritable(room, member.userId)
  roomActivity(room, member.userId, now)
  return asHost(room, () => {
    if (!options(room, messageId)[index]) throw refused()
    if (room.choiceMode === 'gm') {
      if (member.role === 'player') throw refused()
      const state = choiceSnapshot(id, messageId, now)
      if (state.closed) throw new HttpError(409, 'CHOICE_CLOSED', t('选项投票已结束'))
      const message = sendChoice(room, messageId, index, undefined, member.userId)
      state.closed = true
      state.winner = index
      state.picks = [member.userId]
      save(room, 'room.choice', state)
      return message
    }
    const state = choiceSnapshot(id, messageId, now)
    if (state.closed || (room.choiceMode === 'vote' && now >= state.deadline))
      throw new HttpError(409, 'CHOICE_CLOSED', t('选项投票已结束'))
    if (room.choiceMode === 'each') {
      if (state.picks.includes(member.userId)) throw new HttpError(409, 'ALREADY_PICKED', t('你已经选择过此选项组'))
      const message = sendChoice(room, messageId, index, undefined, member.userId)
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
    if (member.role !== 'player' || state.votes[member.userId] !== undefined) throw refused()
    state.votes[member.userId] = index
    state.counts[index] = (state.counts[index] ?? 0) + 1
    save(room, 'room.choice', state)
    armVote(room, state)
    const all = activePlayers(room, now).every((m) => state.votes[m.userId] !== undefined)
    const max = Math.max(...state.counts)
    if (all && state.counts.filter((n) => n === max).length === 1) return closeChoiceAsHost(room, messageId)
    return state
  })
}
function closeChoiceAsHost(room: Room, messageId: string) {
  return asHost(room, () => closeChoice(room.id, messageId))
}
export function closeChoice(id: string, messageId: string, winner?: number) {
  const { room } = requireRole(id, ['owner', 'gm'])
  checkWritable(room, currentUser().id)
  if (room.choiceMode !== 'vote') throw refused()
  return asHost(room, () => {
    const state = choiceSnapshot(id, messageId)
    if (state.closed) return state
    const max = Math.max(...state.counts)
    const selected = winner ?? state.counts.indexOf(max)
    if (!options(room, messageId)[selected] || (winner !== undefined && state.counts[selected] !== max)) throw refused()
    if (turnState(id).running || isGenerating(room.chatId))
      throw new HttpError(409, 'GENERATING', t('房间正在生成回复'))
    checkQuota(room, room.hostUserId)
    db.transaction(() => {
      const voters = Object.keys(state.votes)
      sendChoice(room, messageId, selected, state.counts, voters.length === 1 ? voters[0]! : room.hostUserId)
      state.closed = true
      state.winner = selected
      save(room, 'room.choice', state)
    })
    armVote(room, state)
    triggerTurn(id, room.hostUserId, false)
    return state
  })
}

function notifyPending(room: Room, state: RoomRoundState) {
  if (room.turnMode !== 'host') return
  for (const m of members(room.id))
    if (m.role === 'player' && state.members[m.userId] === 'pending')
      notifyRoom(room, m.userId, 'room.your-turn', `your-turn:${room.id}:${state.round}:${m.userId}`)
}
function notifyInitiative(room: Room, state: RoomInitiativeState) {
  const entry = state.order[state.current]
  if (entry?.kind === 'member')
    notifyRoom(room, entry.id, 'room.your-turn', `your-turn:${room.id}:${roundSnapshot(room).round}:${entry.id}`)
}

/** 转让后清除捕获旧宿主上下文的定时器，再从新库的持久状态恢复。 */
export function stopRoomTimers(id: string) {
  clearTimeout(roundTimers.get(id))
  roundTimers.delete(id)
  for (const [key, timer] of voteTimers)
    if (key.startsWith(`${id}:`)) {
      clearTimeout(timer)
      voteTimers.delete(key)
    }
}
