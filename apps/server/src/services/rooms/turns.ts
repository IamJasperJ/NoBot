import type { GenerateInput, MessageMeta, RoomEvent, roomSendInput } from '@nobot/shared'
import { and, eq } from 'drizzle-orm'
import type { z } from 'zod'
import { db, getSetting, newId, setSetting } from '../../db/client'
import { chats, messages, roomEvents, roomUsage } from '../../db/schema'
import { HttpError } from '../../errors'
import { t } from '../../i18n'
import { stripBidi } from '../../lib/input-text'
import { currentUser } from '../../user-context'
import { getAttachment } from '../attachments'
import { editMessage, getChatRow, loadMessage, loadPath } from '../chats'
import * as generation from '../generation/generation'
import { quietPrompt } from '../generation/quiet-prompt'
import { liveHub } from '../live/hub'
import { notify } from '../social'
import { canReadMessage, roomMessage, roomPayload } from './dto'
import { notifyMentions } from './extensions'
import {
  asHost,
  changed,
  charactersForRoom,
  checkQuota,
  checkWritable,
  event,
  findRoom,
  members,
  membership,
  publish,
  type Room,
  refused,
  reserveUsage,
  roomRow,
} from './index'
import { cleanMessageText, rateLimitMessage, validateEdit } from './input'
import {
  advanceInitiative,
  afterAiTurn,
  assertInitiative,
  initiativeSnapshot,
  registerChoices,
  roomActivity,
} from './trpg'
import { runAsRoomActor } from './usage'

interface TurnState {
  timer?: ReturnType<typeof setTimeout>
  firstAt: number
  pending: string[]
  queued: string[]
  actorId: string
  running: boolean
  cooldownUntil: number
  typingUntil: number
  replyTo?: string
  speakerId?: string
  classified: number
  inputPlayers?: string[]
  deciding?: boolean
}
const states = new Map<string, TurnState>()
export function turnState(id: string) {
  let state = states.get(id)
  if (!state) {
    state = {
      firstAt: 0,
      pending: [],
      queued: [],
      actorId: '',
      running: false,
      cooldownUntil: 0,
      typingUntil: 0,
      classified: 0,
    }
    const room = roomRow(id)
    const saved = asHost(room, () => getSetting<Omit<TurnState, 'timer'>>(`room-turn:${id}`))
    if (saved) {
      Object.assign(state, saved, { running: false, deciding: false })
      // 进程重启时旧生成已被标记中止；把生成期间已确认接收的玩家消息接回可见分支。
      if (state.queued.length)
        asHost(room, () =>
          db.transaction(() => {
            db.update(messages)
              .set({ parentId: getChatRow(room.chatId).activeLeafId })
              .where(eq(messages.id, state!.queued[0]!))
              .run()
            db.update(chats)
              .set({ activeLeafId: state!.queued.at(-1)! })
              .where(eq(chats.id, room.chatId))
              .run()
          }),
        )
      state.queued = []
    }
    states.set(id, state)
  }
  return state
}
export function persistTurn(id: string, state: TurnState) {
  const { timer: _, ...saved } = state
  setSetting(`room-turn:${id}`, saved)
}
function ephemeral(room: Room, type: string, actorId: string, payload: Record<string, unknown>) {
  const data: RoomEvent = { roomId: room.id, type, actorId, payload: roomPayload(payload), createdAt: Date.now() }
  const topic = `room:${room.id}`
  // 模型服务商的原始报错可能带着房主的接口地址等配置，只给房主和主持看，其他人看通用提示
  const raw = typeof payload.error === 'string' || (payload.type === 'error' && typeof payload.message === 'string')
  const spectators = new Set(
    members(room.id)
      .filter((m) => m.role === 'spectator')
      .map((m) => m.userId),
  )
  if (!raw)
    return liveHub.publishToTopic(
      topic,
      { type, topic, data },
      (userId) => !['room.turn', 'room.typing', 'room.suggestion'].includes(type) || !spectators.has(userId),
    )
  const privileged = new Set(members(room.id).flatMap((m) => (['owner', 'gm'].includes(m.role) ? [m.userId] : [])))
  const generic = t('AI 回复失败')
  const masked: RoomEvent = {
    ...data,
    payload: { ...data.payload, ...('error' in payload ? { error: generic } : { message: generic }) },
  }
  liveHub.publishToTopic(topic, { type, topic, data }, (userId) => privileged.has(userId))
  liveHub.publishToTopic(topic, { type, topic, data: masked }, (userId) => !privileged.has(userId))
}
export function broadcastTurn(room: Room) {
  const s = turnState(room.id)
  ephemeral(room, 'room.turn', s.actorId, {
    running: s.running,
    pendingCount: s.pending.length,
    waitingUntil: s.timer ? Math.min(s.firstAt + 15000, Date.now() + 4000) : null,
    cooldownUntil: s.cooldownUntil,
  })
}
export function sendRoomMessage(
  id: string,
  input: z.infer<typeof roomSendInput>,
  extraMeta: MessageMeta = {},
  actorId = currentUser().id,
  followTurnMode = true,
) {
  const { room } = membership(id, actorId)
  const member = checkWritable(room, actorId)
  input = { ...input, text: cleanMessageText(input.text, !!input.images?.length) }
  const state = turnState(id)
  return asHost(room, () => {
    const duplicate = db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, room.chatId), eq(messages.role, 'user')))
      .all()
      .find((m) => m.meta.author?.userId === actorId && m.meta.clientMessageId === input.clientMessageId)
    if (duplicate) return roomMessage(loadMessage(duplicate.id), actorId, room.hostUserId)
    if (input.channel === 'ic' && !extraMeta.choice?.counts) assertInitiative(room, actorId)
    roomActivity(room, actorId)
    const now = Date.now()
    rateLimitMessage(`${id}:${actorId}`, now)
    if (input.replyTo && loadMessage(input.replyTo).chatId !== room.chatId) throw refused()
    const attachments = (input.images ?? []).map((imageId) => {
      const known =
        db
          .select()
          .from(roomEvents)
          .where(eq(roomEvents.roomId, id))
          .all()
          .some((e) => e.type === 'room.asset' && e.entityId === imageId) ||
        db
          .select()
          .from(messages)
          .where(eq(messages.chatId, room.chatId))
          .all()
          .some((m) => m.meta.images?.some((image) => image.id === imageId))
      if (!known) throw new HttpError(400, 'ROOM_ATTACHMENT_UNAVAILABLE', t('所选附件不可用，请重新上传'))
      return getAttachment(imageId)
    })
    const messageId = newId()
    const parentId = state.running
      ? (state.queued.at(-1) ?? getChatRow(room.chatId).activeLeafId)
      : getChatRow(room.chatId).activeLeafId
    const result = db.transaction(() => {
      db.insert(messages)
        .values({
          id: messageId,
          chatId: room.chatId,
          parentId,
          role: 'user',
          content: input.text,
          createdAt: now,
          meta: {
            name: member.personaName,
            author: { userId: actorId, name: member.personaName },
            channel: input.channel,
            excluded: input.channel === 'ooc',
            clientMessageId: input.clientMessageId,
            replyTo: input.replyTo,
            version: 1,
            ...extraMeta,
            ...(attachments.length ? { images: attachments } : {}),
          },
        })
        .run()
      if (!state.running)
        db.update(chats).set({ activeLeafId: messageId, updatedAt: now }).where(eq(chats.id, room.chatId)).run()
      if (state.running) state.queued.push(messageId)
      if (input.channel === 'ic') {
        state.pending.push(messageId)
        state.actorId = actorId
        if (!state.firstAt) state.firstAt = now
      }
      persistTurn(id, state)
      const message = loadMessage(messageId)
      return { message, event: event(room, 'room.message', actorId, { action: 'created', message }, messageId) }
    })
    publish(result.event)
    typingTimes.delete(`${id}:${actorId}`)
    ephemeral(room, 'room.typing', actorId, { userId: actorId, expiresAt: 0 })
    notifyMentions(room, result.message)
    if (followTurnMode && input.channel === 'ic' && !extraMeta.choice?.counts) {
      if (room.turnMode === 'initiative') {
        const initiative = initiativeSnapshot(room)
        const entry = initiative.order[initiative.current]
        if (entry?.kind === 'member' && entry.id === actorId) advanceInitiative(room)
      } else if (!(extraMeta.choice && room.choiceMode === 'each')) schedule(room)
    }
    broadcastTurn(room)
    return result.message
  })
}
export function mentions(text: string, names: string[]) {
  return names.some((name) => name.trim() && text.toLocaleLowerCase().includes(name.toLocaleLowerCase()))
}
export function parseDecision(text: string): {
  respond: boolean
  speaker: string | null
  replyTo: string | null
  reason: string
} {
  try {
    const v: unknown = JSON.parse(text)
    if (
      v &&
      typeof v === 'object' &&
      'respond' in v &&
      typeof v.respond === 'boolean' &&
      'speaker' in v &&
      (v.speaker === null || typeof v.speaker === 'string') &&
      'replyTo' in v &&
      (v.replyTo === null || typeof v.replyTo === 'string') &&
      'reason' in v &&
      typeof v.reason === 'string'
    )
      return { respond: v.respond, speaker: v.speaker, replyTo: v.replyTo, reason: v.reason }
  } catch {
    /* 非严格 JSON 一律不触发，避免模型错误引起刷屏。 */
  }
  return { respond: false, speaker: null, replyTo: null, reason: '' }
}
function addressed(room: Room, s: TurnState) {
  const ai = charactersForRoom(room, false)
  return s.pending.some((id) => {
    const m = loadMessage(id)
    return (
      mentions(
        m.content,
        ai.map((c) => c.name),
      ) ||
      (m.meta.replyTo && loadMessage(m.meta.replyTo).role === 'assistant')
    )
  })
}
function schedule(room: Room) {
  const s = turnState(room.id)
  clearTimeout(s.timer)
  s.timer = undefined
  if (
    s.running ||
    s.deciding ||
    !s.pending.length ||
    ['host', 'initiative'].includes(room.turnMode) ||
    room.status !== 'active'
  )
    return
  if (room.turnMode === 'mention' && !addressed(room, s)) return
  const delay =
    room.turnMode === 'auto'
      ? Math.max(0, Math.min(s.firstAt + 15000, Math.max(Date.now() + 4000, s.typingUntil)) - Date.now())
      : addressed(room, s)
        ? 1500
        : s.pending.length - s.classified >= 3
          ? 1500
          : 20000
  s.timer = setTimeout(() => {
    s.timer = undefined
    const evaluated = s.pending.length
    s.deciding = true
    void Promise.resolve()
      .then(() =>
        asHost(room, async () => {
          try {
            const latest = findRoom(room.id)
            if (!latest) return
            if (latest.status !== 'active' || ['host', 'initiative'].includes(latest.turnMode) || !s.pending.length)
              return
            if (latest.turnMode === 'mention' && !addressed(latest, s)) return
            if (latest.turnMode === 'smart') {
              const history = loadPath(getChatRow(room.chatId).activeLeafId)
                .filter((m) => !m.meta.excluded)
                .slice(-12)
              if (Date.now() < s.cooldownUntil || history.filter((m) => m.role === 'assistant').length >= 4) return
              if (!addressed(room, s)) {
                const players = members(room.id).filter((m) => m.role !== 'spectator')
                const latestMessage = loadMessage(s.pending.at(-1)!)
                if (
                  mentions(
                    latestMessage.content,
                    players.filter((m) => m.userId !== latestMessage.meta.author?.userId).map((m) => m.personaName),
                  )
                )
                  return
                s.classified = s.pending.length
                const answer = await quietPrompt({
                  chatId: room.chatId,
                  instruction:
                    'Decide whether an AI character should respond in this multiplayer scene. Human players may be talking to each other. Respect each character\'s talkativeness. Return only strict JSON: {"respond": boolean, "speaker": "character name or null", "replyTo": "player name or null", "reason": "short reason"}. Use JSON null for missing names. Do not write dialogue. Write the reason in the same language as the conversation.',
                  maxTokens: 150,
                })
                if (!findRoom(room.id)) return
                const decision = parseDecision(answer)
                if (!decision.respond) return
                s.speakerId = charactersForRoom(room, false).find(
                  (c) => c.name === decision.speaker && c.talkativeness > 0,
                )?.id
                s.replyTo = players.find((p) => p.personaName === decision.replyTo)?.personaName
              }
            }
            if (!s.running && s.pending.length) triggerTurn(room.id, s.actorId, false)
          } catch (error) {
            ephemeral(room, 'room.turn', s.actorId, { error: error instanceof Error ? error.message : String(error) })
          } finally {
            s.deciding = false
            const latest = findRoom(room.id)
            if (latest && !s.running && s.pending.length > evaluated) schedule(latest)
          }
        }),
      )
      .catch(() => {
        s.deciding = false
      })
  }, delay)
  s.timer.unref()
  broadcastTurn(room)
}
export function typing(id: string) {
  const { room } = membership(id),
    actor = currentUser().id
  checkWritable(room, actor)
  const s = turnState(id),
    now = Date.now(),
    key = `${id}:${actor}`
  if ((typingTimes.get(key) ?? 0) > now - 1000) return
  typingTimes.set(key, now)
  s.typingUntil = now + 5000
  ephemeral(room, 'room.typing', actor, { userId: actor, expiresAt: now + 5000 })
  if (room.turnMode === 'auto') asHost(room, () => schedule(room))
}
const typingTimes = new Map<string, number>()
export function triggerTurn(
  id: string,
  actorId = currentUser().id,
  manual = true,
  input: GenerateInput = { mode: 'trigger' },
) {
  const { room, member } = membership(id, actorId)
  if (
    input.mode === 'trigger' &&
    input.speakerId &&
    !asHost(room, () => charactersForRoom(room, false).some((c) => c.id === input.speakerId))
  )
    throw new HttpError(400, 'ROOM_SPEAKER_UNAVAILABLE', t('所选发言角色不在房间中或已静音'))
  checkWritable(room, actorId)
  if (input.mode === 'trigger' && input.instruction && !['owner', 'gm'].includes(member.role))
    throw new HttpError(403, 'TRIGGER_INSTRUCTION_FORBIDDEN', t('只有房主和主持可以附带隐藏指令'))
  if (manual && member.role === 'player') throw refused()
  return asHost(room, () => {
    const s = turnState(id)
    if (s.running || generation.isGenerating(room.chatId)) throw new HttpError(409, 'GENERATING', t('房间正在生成回复'))
    checkQuota(room, actorId)
    clearTimeout(s.timer)
    s.timer = undefined
    const pending = [...s.pending]
    s.running = true
    s.queued = []
    s.inputPlayers = [
      ...new Set(pending.map((messageId) => loadMessage(messageId).meta.name).filter((name): name is string => !!name)),
    ]
    s.pending = []
    s.firstAt = 0
    s.classified = 0
    s.actorId = actorId
    persistTurn(id, s)
    let releaseUsage: (() => void) | undefined
    let job: ReturnType<typeof generation.startGeneration>
    try {
      job = runAsRoomActor(actorId, () =>
        generation.startGeneration(
          room.chatId,
          input.mode === 'trigger' && !input.speakerId && s.speakerId ? { ...input, speakerId: s.speakerId } : input,
          {
            beforeMessage: () => {
              const latest = findRoom(id)
              if (!latest) {
                generation.abortGeneration(room.chatId)
                return
              }
              checkWritable(latest, actorId)
              releaseUsage = reserveUsage(latest, actorId)
            },
            saved: (message) => {
              if (!findRoom(id))
                return () => {
                  releaseUsage?.()
                  releaseUsage = undefined
                }
              db.insert(roomUsage)
                .values({
                  id: newId(),
                  roomId: id,
                  userId: actorId,
                  kind: 'text',
                  tokens: (message.meta.usage?.promptTokens ?? 0) + (message.meta.usage?.completionTokens ?? 0),
                  createdAt: Date.now(),
                })
                .run()
              const data = event(room, 'room.generation', actorId, { type: 'done', message }, message.id)
              return () => {
                releaseUsage?.()
                releaseUsage = undefined
                if (!findRoom(id)) return
                publish(data)
                registerChoices(room, message)
              }
            },
          },
        ),
      )
    } catch (error) {
      s.running = false
      s.pending.unshift(...pending)
      persistTurn(id, s)
      throw error
    }
    let messageId: string | null = null,
      index = 0
    generation.subscribe(job, (e) => {
      const latest = findRoom(id)
      if (!latest) {
        releaseUsage?.()
        releaseUsage = undefined
        s.running = false
        return
      }
      if (e.type === 'start') {
        messageId = e.assistantMessage.id
        index = 0
      }
      if (e.type === 'message') {
        const data = db.transaction(() => {
          return event(room, 'room.generation', actorId, { ...e }, e.message.id)
        })
        publish(data)
      } else if (e.type !== 'done') ephemeral(room, 'room.generation', actorId, { ...e, messageId, index: index++ })
      if (e.type === 'complete') {
        releaseUsage?.()
        releaseUsage = undefined
        if (s.queued.length)
          db.transaction(() => {
            db.update(messages)
              .set({ parentId: getChatRow(room.chatId).activeLeafId })
              .where(eq(messages.id, s.queued[0]!))
              .run()
            db.update(chats)
              .set({ activeLeafId: s.queued.at(-1)!, updatedAt: Date.now() })
              .where(eq(chats.id, room.chatId))
              .run()
          })
        s.running = false
        s.queued = []
        s.cooldownUntil = Date.now() + 20000
        s.replyTo = undefined
        s.speakerId = undefined
        s.inputPlayers = undefined
        persistTurn(id, s)
        broadcastTurn(room)
        afterAiTurn(latest)
        // complete 在任务移出锁之前广播，下一轮交给定时器启动。
        if (s.pending.length)
          setTimeout(() => {
            const latest = findRoom(id)
            if (latest) asHost(latest, () => schedule(latest))
          }, 0).unref()
      }
    })
    broadcastTurn(room)
    return { ok: true }
  })
}
export function requestTurn(id: string) {
  const { room } = membership(id)
  checkWritable(room, currentUser().id)
  for (const m of members(id))
    if (['owner', 'gm'].includes(m.role))
      notify(m.userId, 'room.turn.request', currentUser().id, { roomId: id, name: room.name })
}
export function abortTurn(id: string) {
  const { room, member } = membership(id)
  if (!['owner', 'gm'].includes(member.role)) throw refused()
  asHost(room, () => generation.abortGeneration(room.chatId))
}
export function editRoomMessage(id: string, messageId: string, content: string | null) {
  const { room, member } = membership(id),
    actor = currentUser().id
  if (member.role === 'spectator') throw new HttpError(403, 'ROOM_SPECTATOR_READ_ONLY', t('旁观者只能查看房间'))
  if (content !== null) content = validateEdit(stripBidi(content))
  return asHost(room, () => {
    const m = loadMessage(messageId)
    if (m.chatId !== room.chatId || !canReadMessage(m, actor)) throw refused()
    if (turnState(id).running || generation.isGenerating(room.chatId))
      throw new HttpError(409, 'GENERATING', t('房间正在生成回复'))
    const path = loadPath(getChatRow(room.chatId).activeLeafId)
    const position = path.findIndex((p) => p.id === messageId)
    if (member.role === 'player') {
      if (m.role !== 'user' || m.meta.author?.userId !== actor) throw refused()
      if (position < 0 || path.slice(position + 1).some((p) => p.role === 'assistant'))
        throw new HttpError(409, 'ROOM_MESSAGE_EDIT_EXPIRED', t('此消息已收到回复或不在当前分支，无法编辑或撤回'))
    }
    if (content !== null) rateLimitMessage(`${id}:${actor}`, Date.now(), true)
    // 房间撤回保留节点与修订记录，避免删除子树时误删其他玩家的发言。
    const data = db.transaction(() => {
      const meta = {
        ...m.meta,
        version: (m.meta.version ?? 1) + 1,
        edits: [...(m.meta.edits ?? []), { content: m.content, actorId: actor, createdAt: Date.now() }]
          .slice(-10)
          .map((edit) => ({ ...edit, content: edit.content.slice(0, 4000) })),
        ...(content === null ? { excluded: true } : {}),
      }
      db.update(messages).set({ meta }).where(eq(messages.id, messageId)).run()
      const message = editMessage(messageId, content ?? '')
      return {
        message,
        event: event(
          room,
          'room.message',
          actor,
          { action: content === null ? 'deleted' : 'updated', message },
          messageId,
        ),
      }
    })
    publish(data.event)
    return roomMessage(data.message, actor, room.hostUserId)
  })
}
export function suggest(id: string, messageId: string) {
  const { room } = membership(id),
    actor = currentUser().id
  checkWritable(room, actor)
  asHost(room, () => {
    const m = loadMessage(messageId)
    if (m.chatId !== room.chatId) throw refused()
    if (m.role !== 'assistant') throw new HttpError(400, 'ROOM_SUGGESTION_INVALID_MESSAGE', t('只能对模型回复提出建议'))
  })
  changed(room, 'room.suggestion', actor, { messageId, userId: actor, reaction: '👍' })
}

export function rescheduleRoom(id: string) {
  const room = roomRow(id)
  asHost(room, () => schedule(room))
}

/** 宿主切换后必须丢弃持有旧库上下文的唤醒器与内存状态。 */
export function resetTurnState(id: string) {
  clearTimeout(states.get(id)?.timer)
  states.delete(id)
}
