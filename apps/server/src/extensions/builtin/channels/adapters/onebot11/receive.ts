import { z } from 'zod'
import { decodeTelegram } from '../telegram/receive'
import type { OneBotClient, OneBotSegment } from './client'

const object = z.record(z.string(), z.unknown())
const unescapeCQ = (text: string) =>
  text.replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&')
export function oneBotSegments(input: unknown): OneBotSegment[] {
  if (Array.isArray(input))
    return input.flatMap((segment) => {
      const parsed = z.object({ type: z.string(), data: object }).safeParse(segment)
      return parsed.success ? [parsed.data] : []
    })
  if (typeof input !== 'string') return []
  const segments: OneBotSegment[] = []
  let start = 0
  for (const match of input.matchAll(/\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/g)) {
    if (match.index > start)
      segments.push({ type: 'text', data: { text: unescapeCQ(input.slice(start, match.index)) } })
    const data = Object.fromEntries(
      match[2]!
        .split(',')
        .slice(1)
        .map((part) => {
          const equals = part.indexOf('=')
          return [part.slice(0, equals), unescapeCQ(part.slice(equals + 1))]
        }),
    )
    segments.push({ type: match[1]!, data })
    start = match.index + match[0].length
  }
  if (start < input.length) segments.push({ type: 'text', data: { text: unescapeCQ(input.slice(start)) } })
  return segments
}
/** 统一业务事件沿用既有房间桥形状；群 id 在桥内加负号，避免与私聊 id 冲突。 */
export function decodeOneBot(input: unknown, client: OneBotClient) {
  const parsed = object.safeParse(input)
  if (!parsed.success) return null
  const event = parsed.data
  if (
    event.post_type !== 'message' ||
    String(event.user_id) === client.selfId ||
    String(event.user_id) === String(event.self_id)
  )
    return null
  if (event.message_type !== 'private' && event.message_type !== 'group') return null
  if (!Number.isSafeInteger(Number(event.message_id)) || !Number.isSafeInteger(Number(event.user_id))) return null
  const segments = oneBotSegments(event.message)
  const sender = object.safeParse(event.sender).data ?? {}
  const name = String(sender.card || sender.nickname || event.user_id)
  const text = segments
    .map((segment) =>
      segment.type === 'text'
        ? String(segment.data.text ?? '')
        : segment.type === 'face'
          ? `[face:${segment.data.id}]`
          : segment.type === 'at' && /^\d+$/.test(String(segment.data.qq)) && String(segment.data.qq) !== client.selfId
            ? `@${segment.data.qq}`
            : '',
    )
    .join('')
    .trim()
  const mention = segments.find(
    (segment) =>
      segment.type === 'at' && /^\d+$/.test(String(segment.data.qq)) && String(segment.data.qq) !== client.selfId,
  )
  const reply = segments.find((segment) => segment.type === 'reply')
  const media = (kind: 'image' | 'record') =>
    segments
      .filter((segment) => segment.type === kind)
      .map((segment) => ({
        file_id: client.registerMedia(
          kind,
          String(segment.data.file ?? ''),
          typeof segment.data.url === 'string' ? segment.data.url : undefined,
        ),
        mime_type: kind === 'record' ? 'audio/mpeg' : 'image/jpeg',
      }))
  const photos = media('image')
  const group = event.message_type === 'group'
  const decoded = decodeTelegram(
    {
      update_id: Number(event.message_id),
      message: {
        message_id: Number(event.message_id),
        chat: {
          id: group ? -Number(event.group_id) : Number(event.user_id),
          type: group ? 'group' : 'private',
          title: String(event.group_name ?? event.group_id ?? name),
        },
        from: { id: Number(event.user_id), first_name: name },
        text,
        photo: photos.length ? photos : undefined,
        voice: media('record')[0],
        document: segments.some((segment) => segment.type === 'file')
          ? { mime_type: 'application/octet-stream' }
          : undefined,
        reply_to_message: reply
          ? { message_id: Number(reply.data.id) }
          : mention
            ? { message_id: 0, from: { id: Number(mention.data.qq), first_name: String(mention.data.qq) } }
            : undefined,
      },
    },
    { id: client.selfId },
  )
  if (decoded?.type !== 'message') return null
  decoded.mentionsBot = segments.some((segment) => segment.type === 'at' && String(segment.data.qq) === client.selfId)
  decoded.dedupeKey = `onebot:${event.message_id}`
  return decoded
}
