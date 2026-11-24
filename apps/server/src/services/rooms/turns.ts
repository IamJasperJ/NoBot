import type { GenerateInput, MessageMeta, RoomEvent, roomSendInput, SetVarsInput, SwipeInput } from '@nobot/shared'
import { and, eq } from 'drizzle-orm'
import type { z } from 'zod'
import { db, getSetting, newId, setSetting } from '../../db/client'
import { chats, messages, roomEvents, roomUsage } from '../../db/schema'
import { HttpError } from '../../errors'
import { t } from '../../i18n'
import { stripBidi } from '../../lib/input-text'
import { currentUser } from '../../user-context'
import { getAttachment } from '../attachments'
import { editMessage, getChatRow, loadMessage, loadPath, setVars, swipe } from '../chats'
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
  unavailable,
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
  inputPlayers?: string[]
  deciding?: AbortController
  /** 定时器预计触发的时间，给前端显示「等待中」 */
  dueAt?: number
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
    }
    const room = roomRow(id)
    const saved = asHost(room, () => getSetting<Omit<TurnState, 'timer' | 'deciding'>>(`room-turn:${id}`))
    if (saved) {
      Object.assign(state, saved, {
        running: false,
        deciding: undefined,
        dueAt: undefined,
        replyTo: undefined,
        speakerId: undefined,
        inputPlayers: undefined,
      })
      // 进程重启时旧生成已被标记中止；把生成期间已确认接收的玩家消息接回可见分支。
      const restored = state
      if (restored.queued.length)
        asHost(room, () =>
          db.transaction(() => {
            reconnectQueued(room, restored)
            persistTurn(id, restored)
          }),
        )
    }
    states.set(id, state)
  }
  return state
}
export function persistTurn(id: string, state: TurnState) {
  const { timer: _, deciding: _decision, ...saved } = state
  setSetting(`room-turn:${id}`, saved)
}

/** 调用方在同一事务里保存新叶子和清空后的队列，重启可安全重复恢复。 */
function reconnectQueued(room: Room, state: TurnState) {
  if (!state.queued.length) return
  const queued = state.queued.filter((id) => loadPath(id, 1)[0]?.chatId === room.chatId)
  const first = queued[0]
  if (first) {
    const leaf = getChatRow(room.chatId).activeLeafId
    const last = queued.at(-1)!
    // 兼容在旧版本中已经换过叶子、尚未来得及清队列的存档。
    if (!leaf || !queued.includes(leaf)) db.update(messages).set({ parentId: leaf }).where(eq(messages.id, first)).run()
    if (leaf !== last)
      db.update(chats).set({ activeLeafId: last, updatedAt: Date.now() }).where(eq(chats.id, room.chatId)).run()
  }
  state.queued = []
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
export function roomTurnSnapshot(id: string) {
  const state = turnState(id)
  return {
    actorId: state.actorId,
    payload: {
      running: state.running,
      pendingCount: state.pending.length,
      waitingUntil: state.timer ? (state.dueAt ?? null) : null,
      cooldownUntil: state.cooldownUntil,
    },
  }
}
export function broadcastTurn(room: Room) {
  const { actorId, payload } = roomTurnSnapshot(room.id)
  ephemeral(room, 'room.turn', actorId, payload)
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
/**
 * 解析「该不该接话」的判断。模型常把 JSON 包进代码框或在前后加说明，这里取第一个 {...} 再解析。
 * 找不到 JSON 或解析失败返回 null（交给调用方决定默认行为）；JSON 字段不合格时按不接话处理
 */
export function parseDecision(text: string): {
  respond: boolean
  speaker: string | null
  replyTo: string | null
  reason: string
} | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    const v: unknown = JSON.parse(text.slice(start, end + 1))
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
    return null
  }
  return { respond: false, speaker: null, replyTo: null, reason: '' }
}

/** 已撤回、删除或切离激活分支的消息不再参与待回复队列。 */
function prunePending(room: Room, state: TurnState) {
  if (!state.pending.length) return
  const ids = new Set(state.pending)
  const path = loadPath(getChatRow(room.chatId).activeLeafId)
  const pending = path.filter((m) => ids.has(m.id) && m.role === 'user' && !m.meta.excluded)
  if (pending.length === state.pending.length) return
  state.pending = pending.map((m) => m.id)
  state.firstAt = pending[0]?.createdAt ?? 0
  state.actorId = pending.at(-1)?.meta.author?.userId ?? room.hostUserId
  persistTurn(room.id, state)
}

/** 待回应的消息里有没有叫到 AI：点了角色名、回复了 AI 的消息；智能接话里带问号的提问也算 */
function addressed(room: Room, s: TurnState) {
  const ai = charactersForRoom(room, false)
  return s.pending.some((id) => {
    const m = loadPath(id, 1)[0]
    if (!m || m.meta.excluded) return false
    return (
      mentions(
        m.content,
        ai.map((c) => c.name),
      ) ||
      (m.meta.replyTo && loadPath(m.meta.replyTo, 1)[0]?.role === 'assistant') ||
      (room.turnMode === 'smart' && /[?？]/.test(m.content))
    )
  })
}
/** 自动回应和智能接话共用的「安静几秒」：最后一次发言或输入后 4 秒，最多从第一条算起等 15 秒 */
function quietDelay(s: TurnState) {
  return Math.min(s.firstAt + 15000, Math.max(Date.now() + 4000, s.typingUntil)) - Date.now()
}
function schedule(room: Room) {
  const s = turnState(room.id)
  clearTimeout(s.timer)
  s.timer = undefined
  s.dueAt = undefined
  if (s.deciding) {
    s.deciding.abort()
    return
  }
  if (!s.running) prunePending(room, s)
  if (s.running || !s.pending.length || ['host', 'initiative'].includes(room.turnMode) || room.status !== 'active')
    return broadcastTurn(room)
  const mentioned = room.turnMode === 'mention' || room.turnMode === 'smart' ? addressed(room, s) : false
  if (room.turnMode === 'mention' && !mentioned) return broadcastTurn(room)
  // 智能接话尽量多接：叫到、提问时很快回应，其余等大家安静几秒再判断；刚回完话的短冷却只推迟、不丢弃
  // 每条都接：不判断，只留 1 秒把连着发的几句合成一轮
  const wait =
    room.turnMode === 'every'
      ? 1000
      : room.turnMode === 'auto'
        ? quietDelay(s)
        : mentioned
          ? 1500
          : room.turnMode === 'smart'
            ? quietDelay(s)
            : 0
  const delay = Math.max(0, wait, room.turnMode === 'smart' ? s.cooldownUntil - Date.now() : 0)
  s.dueAt = Date.now() + delay
  s.timer = setTimeout(() => {
    s.timer = undefined
    s.dueAt = undefined
    const decisionTask = new AbortController()
    s.deciding = decisionTask
    void Promise.resolve()
      .then(() =>
        asHost(room, async () => {
          try {
            const latest = findRoom(room.id)
            if (!latest || decisionTask.signal.aborted) return
            prunePending(latest, s)
            if (latest.status !== 'active' || ['host', 'initiative'].includes(latest.turnMode) || !s.pending.length)
              return
            if (latest.turnMode === 'mention' && !addressed(latest, s)) return
            if (latest.turnMode === 'smart' && !addressed(latest, s)) {
              const leafId = getChatRow(room.chatId).activeLeafId
              const lastPending = s.pending.at(-1)
              const answer = await quietPrompt({
                chatId: room.chatId,
                leafId,
                instruction:
                  'Decide whether an AI character should respond in this multiplayer scene. The players want the AI characters to join in as often as possible, so lean strongly towards responding. Only answer false when the latest messages are clearly a private exchange between human players that a character would not take part in. Pick a speaker who fits the topic and respect each character\'s talkativeness. Return only strict JSON: {"respond": boolean, "speaker": "character name or null", "replyTo": "player name or null", "reason": "short reason"}. Use JSON null for missing names. Do not write dialogue. Write the reason in the same language as the conversation.',
                maxTokens: 300,
                signal: AbortSignal.any([decisionTask.signal, AbortSignal.timeout(30_000)]),
              }).catch(() => null)
              const current = findRoom(room.id)
              if (decisionTask.signal.aborted || !current || current.status !== 'active' || s.running) return
              // 消息和设置可在判断期间变化，旧结果不能替新一轮挑选角色。
              if (current.turnMode !== latest.turnMode || s.pending.at(-1) !== lastPending) {
                decisionTask.abort()
                return
              }
              // 请求失败时沿用普通回复；明确拒绝的批次已经处理，正文仍在对话中。
              const decision = answer === null ? null : parseDecision(answer)
              if (decision && !decision.respond) {
                s.pending = []
                s.firstAt = 0
                persistTurn(room.id, s)
                broadcastTurn(current)
                return
              }
              if (decision) {
                s.speakerId = charactersForRoom(current, false).find(
                  (c) => c.name === decision.speaker && c.talkativeness > 0,
                )?.id
                s.replyTo = members(current.id).find(
                  (p) => p.role !== 'spectator' && p.personaName === decision.replyTo,
                )?.personaName
              }
            }
            if (!s.running && s.pending.length) triggerTurn(room.id, s.actorId, false)
          } catch (error) {
            s.replyTo = undefined
            s.speakerId = undefined
            ephemeral(room, 'room.turn', s.actorId, { error: error instanceof Error ? error.message : String(error) })
          } finally {
            s.deciding = undefined
            const latest = findRoom(room.id)
            if (latest && states.get(room.id) === s && !s.running && decisionTask.signal.aborted) schedule(latest)
          }
        }),
      )
      .catch(() => {
        s.deciding = undefined
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
  // 还在等大家安静下来时，有人在输入就顺延；已经叫到 AI 的不再推迟
  if (room.turnMode === 'auto' || (room.turnMode === 'smart' && s.timer && !asHost(room, () => addressed(room, s))))
    asHost(room, () => schedule(room))
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
    if (manual) s.deciding?.abort()
    prunePending(room, s)
    clearTimeout(s.timer)
    s.timer = undefined
    s.dueAt = undefined
    const pending = [...s.pending]
    const { firstAt, actorId: pendingActor } = s
    s.running = true
    s.queued = []
    s.inputPlayers = [
      ...new Set(pending.map((messageId) => loadMessage(messageId).meta.name).filter((name): name is string => !!name)),
    ]
    s.pending = []
    s.firstAt = 0
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
      s.firstAt = firstAt
      s.actorId = pendingActor
      s.inputPlayers = undefined
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
        db.transaction(() => {
          reconnectQueued(room, s)
          s.running = false
          // 刚回完话的短冷却：避免连发两条，期间的新消息顺延到冷却结束。
          s.cooldownUntil = Date.now() + 3000
          s.replyTo = undefined
          s.speakerId = undefined
          s.inputPlayers = undefined
          persistTurn(id, s)
        })
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
export function swipeRoom(id: string, input: SwipeInput) {
  const { room } = membership(id)
  const actor = currentUser().id
  const member = checkWritable(room, actor)
  if (!['owner', 'gm'].includes(member.role)) throw unavailable()
  return asHost(room, () => {
    const message = loadMessage(input.messageId)
    if (message.chatId !== room.chatId || !canReadMessage(message, actor)) throw unavailable()
    const data = db.transaction(() => {
      const leafId = swipe(room.chatId, input.messageId, input.direction)
      return { leafId, event: event(room, 'room.message', actor, { action: 'activated', leafId }) }
    })
    publish(data.event)
    if (data.leafId) schedule(room)
    return { leafId: data.leafId }
  })
}
export function setRoomVars(id: string, input: SetVarsInput) {
  const { room } = membership(id)
  const actor = currentUser().id
  const member = checkWritable(room, actor)
  if (!['owner', 'gm'].includes(member.role)) throw unavailable()
  return asHost(room, () => {
    const data = db.transaction(() => {
      const leafId = getChatRow(room.chatId).activeLeafId
      if (leafId && !canReadMessage(loadMessage(leafId), actor)) throw unavailable()
      const result = setVars(room.chatId, input)
      const message = loadMessage(leafId!)
      return { result, event: event(room, 'room.message', actor, { action: 'updated', message }, message.id) }
    })
    publish(data.event)
    if (turnState(id).deciding) schedule(room)
    return data.result
  })
}
export function editRoomMessage(id: string, messageId: string, content: string | null, reasoning?: string) {
  const { room } = membership(id)
  const actor = currentUser().id
  const member = checkWritable(room, actor)
  if (content !== null) content = validateEdit(stripBidi(content))
  return asHost(room, () => {
    const m = loadMessage(messageId)
    if (m.chatId !== room.chatId || !canReadMessage(m, actor)) throw refused()
    const state = turnState(id)
    if (state.running || generation.isGenerating(room.chatId))
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
    const pending = state.pending.includes(messageId)
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
      const message = editMessage(messageId, content ?? '', content === null ? '' : reasoning)
      if (content === null && pending) prunePending(room, state)
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
    if (pending || state.deciding) schedule(room)
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
  const state = states.get(id)
  clearTimeout(state?.timer)
  state?.deciding?.abort()
  states.delete(id)
}
