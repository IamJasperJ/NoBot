import type { Delivery, LineDelivery, MessageDTO, SpokenLine, TtsSpeaker } from '@nobot/shared'
import { parseStageMessage } from './parse'

export interface TtsSegment {
  speaker: TtsSpeaker
  text: string
  expression?: string
  delivery?: LineDelivery
  cues?: SpokenLine['cues']
  director?: Partial<Delivery>
  beatIndex?: number
}
/** 与整条消息朗读共用的分段规则；流式末段留待后续文本或完成事件确认。 */
export function speechSegments(
  message: Pick<MessageDTO, 'role' | 'content' | 'meta' | 'speakerId'>,
  members: { id: string; name: string }[],
  streaming = false,
): TtsSegment[] {
  return completeSegments(message, members, streaming)
}

function completeSegments(
  message: Pick<MessageDTO, 'role' | 'content' | 'meta' | 'speakerId'>,
  members: { id: string; name: string }[],
  streaming: boolean,
): TtsSegment[] {
  if (message.role === 'user') return [{ speaker: { kind: 'user' }, text: message.content, beatIndex: 0 }]
  const beats =
    message.meta.stage?.beats ??
    parseStageMessage(message.content, {
      knownNames: members.map((m) => m.name),
      vars: {},
      inline: false,
      mvu: false,
    }).stage.beats
  const speaker: TtsSpeaker = message.speakerId
    ? { kind: 'character', characterId: message.speakerId }
    : members.length === 1
      ? { kind: 'character', characterId: members[0]!.id }
      : message.meta.name
        ? { kind: 'npc', name: message.meta.name }
        : { kind: 'narrator' }
  // narration 拍也可能夹有角色引语，与普通聊天共用同一套归属规则。
  const quotedSegments = (text: string, pending = false): TtsSegment[] => {
    const segments: TtsSegment[] = []
    const pattern = /"([^"\n]+)"|“([^”]+)”|「([^」]+)」|『([^』]+)』/g
    // 开引号已足以确认前段旁白结束，但未闭合的引语不能当作旁白提前提交。
    const opening = /["“「『]/g
    const closing: Record<string, string> = { '"': '"', '“': '”', '「': '」', '『': '』' }
    if (pending) {
      let cursor = 0
      for (let match = opening.exec(text); match; match = opening.exec(text)) {
        if (match.index > cursor)
          segments.push({ speaker: { kind: 'narrator' }, text: text.slice(cursor, match.index) })
        const end = text.indexOf(closing[match[0]]!, match.index + 1)
        if (end < 0 || end === text.length - 1) return segments
        const quote = text.slice(match.index + 1, end)
        if (quote) segments.push({ speaker, text: quote })
        cursor = end + 1
        opening.lastIndex = cursor
      }
      return segments
    }
    let start = 0
    for (const match of text.matchAll(pattern)) {
      if (match.index > start) segments.push({ speaker: { kind: 'narrator' }, text: text.slice(start, match.index) })
      segments.push({ speaker, text: match.slice(1).find((value) => value !== undefined)! })
      start = match.index + match[0].length
    }
    if (start < text.length) segments.push({ speaker: { kind: 'narrator' }, text: text.slice(start) })
    return segments
  }
  if (!message.meta.stage && !beats.some((beat) => beat.kind === 'line')) {
    return quotedSegments(message.content, streaming).map((segment) => ({ ...segment, beatIndex: 0 }))
  }
  return beats.flatMap((b, beatIndex): TtsSegment[] =>
    b.kind === 'line'
      ? streaming && beatIndex === beats.length - 1
        ? []
        : [
            {
              speaker: { kind: 'npc', name: b.speaker },
              text: b.text,
              expression: b.expression,
              delivery: b.delivery,
              cues: b.cues,
              beatIndex,
            },
          ]
      : b.kind === 'narration'
        ? quotedSegments(b.text, streaming && beatIndex === beats.length - 1).map((segment) => ({
            ...segment,
            beatIndex,
          }))
        : [],
  )
}
