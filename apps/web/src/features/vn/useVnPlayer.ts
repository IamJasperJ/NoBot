import { applyStageOps, castKey, emptyStage, parseStageMessage } from '@ai-parter/core/stage'
import type { Beat, MessageDTO, PlayPresetData, StageOp, StageState } from '@ai-parter/shared'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api/client'
import { useStreaming } from '../../stores/streaming'
import { useVn } from '../../stores/vn'

/**
 * VN 播放器（VN3）：一次演一条角色回复，一句一拍。
 *
 * - 演哪条：默认是最后一条角色回复，停在它的最后一拍（打开视图时不重演）；有新回复（包括正在流式生成的）就从它的第一拍开始演；
 *   回想里点「从这里重演」可以换成任意一条
 * - 拍：完成的消息用后端解析好的 meta.stage.beats；流式中的消息在前端用同一个解析器现解析，最后一拍可能没写完，先不演
 * - 舞台：这条消息之前的舞台（后端算好）+ 演到当前拍为止的舞台操作；台词拍里带的表情、说话人上台也算进去
 * - 推进：文字没显示完 → 立刻显示完；显示完 → 下一拍。舞台操作拍不停留，直接跳过去
 */

/** 带成对引号的段落（中文直角引号、弯引号、英文引号） */
const QUOTED = /[「『“"][^」』”"]+[」』”"]/

/** 成对的 *斜体* / **粗体** 星号 */
const STARS = /\*{1,3}([^*\n]+?)\*{1,3}/g

/** 会停下来给人看的拍；舞台操作、CG、音效都是「路过」的拍 */
export type ShownBeat = Extract<Beat, { kind: 'line' | 'narration' | 'choices' }>
const isShown = (beat: Beat): beat is ShownBeat =>
  beat.kind === 'line' || beat.kind === 'narration' || beat.kind === 'choices'

/** 拍里要逐字显示的文字（选项拍没有文字） */
export const beatText = (beat: ShownBeat | undefined) => (beat && beat.kind !== 'choices' ? beat.text : '')

/** 一拍对舞台的影响：舞台操作拍是它自己的操作；台词拍是「说话的人上台，并换成这个表情」 */
function beatOps(beat: Beat): StageOp[] {
  if (beat.kind === 'stage') return beat.ops
  if (beat.kind === 'line')
    return beat.expression
      ? [{ op: 'expr', who: beat.speaker, expression: beat.expression }]
      : [{ op: 'show', who: beat.speaker }]
  return []
}

export interface PlayerOptions {
  chatId: string
  messages: MessageDTO[]
  play: PlayPresetData
  knownNames: string[]
  /** 会话成员（角色卡 id 和名字），用来给前端新加上台的演员关联角色卡 */
  members: { id: string; name: string }[]
}

export function useVnPlayer({ chatId, messages, play, knownNames, members }: PlayerOptions) {
  // 分开订阅两个基本值：选择器返回新对象会让 zustand 以为状态一直在变，无限重渲染
  const liveId = useStreaming((s) => (s.chatId === chatId ? s.messageId : null))
  const liveText = useStreaming((s) => (s.chatId === chatId ? s.text : ''))
  const live = liveId ? { id: liveId, text: liveText } : null
  // 纯图片消息（图片生成插进来的）没有文字可演，跳过；正在流式生成的消息内容还是空的，也算
  const replies = useMemo(
    () => messages.filter((m) => m.role === 'assistant' && (m.content.trim() || m.status === 'streaming')),
    [messages],
  )
  const latest = replies.at(-1) ?? null

  // 正在演的消息；null 表示跟着最新一条
  const [pinnedId, setPinnedId] = useState<string | null>(null)
  const currentId = pinnedId ?? live?.id ?? latest?.id ?? null
  const current = messages.find((m) => m.id === currentId) ?? null
  const streaming = !!live?.id && live.id === currentId
  // 演出的单位是「消息的某个备选」：切换备选回复 / 开场白后内容整个换了，要从头演，读过标记也分开记
  const playKey = current ? `${current.id}#${current.swipeIndex}` : null
  // 这条回复的说话人（单聊是那个角色，群聊是这次发言的成员）。
  // 单聊的开场白是建会话时写入的，没有 speakerId，按唯一的成员算
  const speakerName = current
    ? (members.find((m) => m.id === current.speakerId)?.name ??
      current.meta.name ??
      (members.length === 1 ? (members[0]?.name ?? null) : null))
    : null

  // ---- 拍 ----
  const narrators = useMemo(() => (play.trpg.gmName ? [play.trpg.gmName] : []), [play.trpg.gmName])
  const beats = useMemo<Beat[]>(() => {
    if (!current) return []
    // 关了「边生成边播放」：等这条生成完再演
    if (streaming && !play.dialog.streamPlay) return []
    const text = streaming ? (live?.text ?? '') : current.content
    if (!streaming && current.meta.stage) return current.meta.stage.beats
    const parsed = parseStageMessage(text, {
      knownNames,
      narratorNames: narrators,
      vars: {},
      inline: false,
      mvu: false,
      narrationSplit: play.dialog.narrationSplit,
    }).stage.beats
    // 流式时最后一拍可能只写了一半，先不演
    return streaming ? parsed.slice(0, -1) : parsed
  }, [current, streaming, live?.text, knownNames, narrators, play.dialog.narrationSplit, play.dialog.streamPlay])
  // 大多数角色卡的开场白、不按指令写的回复：「*动作* 「台词」」这种带引号的段落算说话人说的，显示名牌
  const quotedBeats = useMemo<Beat[]>(
    () =>
      speakerName
        ? beats.map((b) =>
            b.kind === 'narration' && QUOTED.test(b.text) ? { kind: 'line', speaker: speakerName, text: b.text } : b,
          )
        : beats,
    [beats, speakerName],
  )
  // 酒馆卡常用 *动作* 的 Markdown 斜体写动作；对话框里不渲染 Markdown，去掉星号只留文字
  const shownBeats = useMemo<Beat[]>(
    () =>
      quotedBeats.map((b) =>
        b.kind === 'line' || b.kind === 'narration' ? { ...b, text: b.text.replace(STARS, '$1').trim() } : b,
      ),
    [quotedBeats],
  )
  const shownIndexes = useMemo(() => shownBeats.flatMap((b, i) => (isShown(b) ? [i] : [])), [shownBeats])

  // ---- 位置：shown 是 shownIndexes 的下标；revealed 是当前拍已经显示的字数 ----
  const [cursor, setCursor] = useState<{ id: string | null; shown: number; revealed: number }>({
    id: null,
    shown: 0,
    revealed: 0,
  })
  // 换了一条消息：打开视图之后才生成的（包括正在生成的）从头演；打开前就有的直接停在最后一拍。
  // 按时间判断，而不是「第一次看到的那条」：刷新页面时消息是后取回来的，不能当成新回复重演
  const openedAt = useRef(Date.now())
  useEffect(() => {
    if (cursor.id === playKey || !current) return
    // 新会话还没有人说过话：开场白也从头演；同一条消息换了备选（切换、重新生成）也从头演
    const opening = !messages.some((m) => m.role === 'user')
    const swiped = !!cursor.id?.startsWith(`${current.id}#`)
    const fresh = streaming || opening || swiped || current.createdAt > openedAt.current
    setCursor({
      id: playKey,
      shown: fresh ? 0 : Math.max(0, shownIndexes.length - 1),
      revealed: fresh ? 0 : Number.POSITIVE_INFINITY,
    })
  }, [playKey, current, cursor.id, streaming, shownIndexes.length, messages])
  // 生成结束、跟随最新时：手动重演的那条如果就是最新的，取消固定
  useEffect(() => {
    if (pinnedId && pinnedId === latest?.id && !live?.id) setPinnedId(null)
  }, [pinnedId, latest?.id, live?.id])

  const shownCount = shownIndexes.length
  const index = Math.min(cursor.shown, Math.max(0, shownCount - 1))
  const beatIndex = shownIndexes.at(index)
  const beat = beatIndex === undefined ? undefined : (shownBeats.at(beatIndex) as ShownBeat | undefined)
  const text = beatText(beat)
  // 选项拍本身没有文字：对话框里继续显示它前面那一句（名牌也跟着那一句）
  const lastSaid = useMemo(() => {
    if (beat?.kind !== 'choices' || beatIndex === undefined) return undefined
    for (let i = beatIndex - 1; i >= 0; i--) {
      const b = shownBeats[i]
      if (b && (b.kind === 'line' || b.kind === 'narration')) return b
    }
    return undefined
  }, [beat, beatIndex, shownBeats])
  const textLength = Array.from(text).length
  const revealed = Math.min(cursor.revealed, textLength)
  const complete = revealed >= textLength
  const atLast = index >= shownCount - 1
  // 演完：最后一拍显示完，并且消息已经生成完（流式中后面可能还有拍）
  const ended = !current || (atLast && complete && !streaming)

  // ---- 舞台 ----
  const base = useQuery({
    queryKey: ['vn-stage', chatId, currentId],
    queryFn: () => api.getStageBefore(chatId, currentId as string),
    enabled: !!currentId,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const stage = useMemo<StageState>(() => {
    let state = base.data?.stage ?? emptyStage()
    // 说话人自动上台：回复里没有舞台指令安排他上下台时，从第一拍起他就在台上
    // （只算明确的舞台指令；台词不算，否则开场白先写一段动作旁白时，角色要等到开口才出现）
    if (speakerName) {
      const keys = [castKey(speakerName), castKey(speakerName.trim().split(/\s+/)[0] ?? '')]
      const mentioned = shownBeats.some(
        (b) =>
          b.kind === 'stage' &&
          b.ops.some((op) => (op.op === 'show' || op.op === 'hide') && keys.includes(castKey(op.who))),
      )
      if (!mentioned) state = applyStageOps(state, [{ op: 'show', who: speakerName }])
    }
    const upTo = beatIndex ?? shownBeats.length - 1
    for (let i = 0; i <= upTo && i < shownBeats.length; i++) state = applyStageOps(state, beatOps(shownBeats[i]!))
    // 这条回复里才上台的人是前端加的，没有关联角色卡；按和后端一样的规则补上：
    // 先比完整名字，再比名字的第一个词（Ellie ↔ Ellie Sunleaf）
    const match = (key: string) =>
      members.find((m) => castKey(m.name) === key) ??
      members.find((m) => castKey(m.name.trim().split(/\s+/)[0] ?? '') === key)
    return {
      ...state,
      cast: state.cast.map((m) => (m.characterId ? m : { ...m, characterId: match(m.key)?.id ?? null })),
    }
  }, [base.data, shownBeats, beatIndex, members, speakerName])
  const speakerKey = beat?.kind === 'line' ? castKey(beat.speaker) : null

  // ---- 读过标记 ----
  const read = useVn((s) => s.read)
  const markRead = useVn((s) => s.markRead)
  const readKey = playKey && beatIndex !== undefined ? `${playKey}:${beatIndex}` : null
  useEffect(() => {
    if (readKey && complete && !streaming) markRead([readKey])
  }, [readKey, complete, streaming, markRead])
  const isRead = (shown: number) => {
    const i = shownIndexes.at(shown)
    return i !== undefined && !!playKey && read.includes(`${playKey}:${i}`)
  }

  // ---- 推进 ----
  const keyOf = (m: MessageDTO) => `${m.id}#${m.swipeIndex}`
  // 前后相邻的回复（回退 / 前进跨消息用）
  const position = current ? replies.findIndex((m) => m.id === current.id) : -1
  const prevReply = position > 0 ? replies[position - 1] : undefined
  const nextReply = position >= 0 ? replies[position + 1] : undefined
  const advance = useCallback(() => {
    // 重看旧回复时演到头：接着看下一条（已经看过的，直接显示整句）；下一条是最新的就回到跟随最新
    if (pinnedId && ended && nextReply) {
      setPinnedId(nextReply.id === latest?.id ? null : nextReply.id)
      setCursor({ id: keyOf(nextReply), shown: 0, revealed: Number.POSITIVE_INFINITY })
      return
    }
    setCursor((c) => {
      if (c.id !== playKey) return c
      const shown = Math.min(c.shown, Math.max(0, shownCount - 1))
      if (c.revealed < textLength) return { ...c, shown, revealed: Number.POSITIVE_INFINITY }
      if (shown < shownCount - 1) {
        // 回退后再往前走：读过的句子直接整句显示，不再逐字打一遍
        const i = shownIndexes[shown + 1]
        const seen = i !== undefined && read.includes(`${playKey}:${i}`)
        return { ...c, shown: shown + 1, revealed: seen ? Number.POSITIVE_INFINITY : 0 }
      }
      return c
    })
  }, [playKey, textLength, shownCount, shownIndexes, read, pinnedId, ended, nextReply, latest?.id])
  /** 回退：这条回复里往回一句（整句显示）；已经是第一句就回到上一条回复的最后一句 */
  const back = useCallback(() => {
    if (index > 0) {
      setCursor((c) => ({ ...c, shown: index - 1, revealed: Number.POSITIVE_INFINITY }))
      return
    }
    if (!prevReply) return
    setPinnedId(prevReply.id)
    // 不知道上一条有几拍：给一个足够大的下标，显示时会被夹到最后一拍
    setCursor({ id: keyOf(prevReply), shown: Number.MAX_SAFE_INTEGER, revealed: Number.POSITIVE_INFINITY })
  }, [index, prevReply])
  const canBack = index > 0 || !!prevReply
  const jumpToEnd = useCallback(() => {
    setCursor((c) => ({ ...c, shown: Math.max(0, shownCount - 1), revealed: Number.POSITIVE_INFINITY }))
  }, [shownCount])
  const replay = useCallback(
    (messageId: string) => {
      setPinnedId(messageId === latest?.id ? null : messageId)
      const target = messages.find((m) => m.id === messageId)
      setCursor({ id: target ? `${target.id}#${target.swipeIndex}` : null, shown: 0, revealed: 0 })
    },
    [latest?.id, messages],
  )

  // ---- 打字机：按「字 / 秒」逐字显示；0 表示瞬间 ----
  const cps = play.dialog.cps
  useEffect(() => {
    if (complete || !beat) return
    if (cps <= 0) {
      setCursor((c) => ({ ...c, revealed: Number.POSITIVE_INFINITY }))
      return
    }
    let frame = 0
    let last = performance.now()
    let carry = 0
    const tick = (now: number) => {
      carry += ((now - last) / 1000) * cps
      last = now
      const step = Math.floor(carry)
      if (step > 0) {
        carry -= step
        setCursor((c) => ({ ...c, revealed: Math.min(c.revealed + step, textLength) }))
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [complete, beat, cps, textLength])

  // ---- 自动播放：显示完后停一会儿再推进（字越多停得越久一点） ----
  const [auto, setAuto] = useState(play.dialog.autoDefault)
  useEffect(() => {
    if (!auto || !complete || atLast || beat?.kind === 'choices') return
    const delay = play.dialog.autoDelay * 1000 + Math.min(textLength * 30, 3000)
    const timer = setTimeout(advance, delay)
    return () => clearTimeout(timer)
  }, [auto, complete, atLast, beat?.kind, textLength, advance, play.dialog.autoDelay])

  // ---- 快进：读过的拍飞快地过；遇到没读过的（设置了「只跳读过的」时）或到头就停 ----
  const [skip, setSkip] = useState(false)
  useEffect(() => {
    if (!skip) return
    if (atLast && complete) {
      setSkip(false)
      return
    }
    if (play.dialog.skipReadOnly && !isRead(index)) {
      setSkip(false)
      return
    }
    const timer = setTimeout(advance, 60)
    return () => clearTimeout(timer)
  })

  return {
    current,
    streaming,
    beat,
    beats: shownBeats,
    index,
    shownCount,
    revealedText: lastSaid ? lastSaid.text : Array.from(text).slice(0, revealed).join(''),
    /** 对话框里显示的那一拍：一般就是当前拍；选项拍时是它前面那一句 */
    said: lastSaid ?? (beat?.kind === 'choices' ? undefined : beat),
    complete,
    ended,
    stage,
    stageReady: !base.isPending,
    speakerKey,
    auto,
    setAuto,
    skip,
    setSkip,
    advance,
    back,
    canBack,
    jumpToEnd,
    replay,
    pinned: pinnedId !== null,
    followLatest: () => setPinnedId(null),
  }
}

export type VnPlayer = ReturnType<typeof useVnPlayer>
