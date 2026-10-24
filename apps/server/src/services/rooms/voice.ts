import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, newId } from '../../db/client'
import { messages, roomEvents, roomUsage } from '../../db/schema'
import { forwardExtension } from '../../extensions/registry'
import { loadMessage } from '../chats'
import { canReadMessage } from './dto'
import {
  asHost,
  charactersForRoom,
  checkWritable,
  event,
  membership,
  publish,
  reserveUsage,
  unavailable,
} from './index'

const pending = new Map<string, Promise<Response>>()
function copyResponse(response: Response) {
  const copy = response.clone()
  return new Response(copy.body, { status: copy.status, headers: [...copy.headers] })
}
/** 合成只接受本房间消息；返回的缓存文件通过持久事件登记归属，不能按猜测的哈希下载。 */
export async function roomVoice(roomId: string, request: Request) {
  const { room, member } = membership(roomId)
  checkWritable(room, member.userId)
  const input: unknown = await request.json()
  if (
    !input ||
    typeof input !== 'object' ||
    !('chatId' in input) ||
    input.chatId !== room.chatId ||
    !('messageId' in input) ||
    typeof input.messageId !== 'string' ||
    !('text' in input) ||
    typeof input.text !== 'string' ||
    !('speaker' in input) ||
    !input.speaker ||
    typeof input.speaker !== 'object' ||
    !('kind' in input.speaker)
  )
    throw unavailable()
  const messageId = input.messageId,
    speaker = input.speaker
  return asHost(room, async () => {
    const message = loadMessage(messageId)
    if (message.chatId !== room.chatId || !canReadMessage(message, member.userId, room.hostUserId)) throw unavailable()
    if (speaker.kind === 'character') {
      if (!('characterId' in speaker) || !charactersForRoom(room).some((c) => c.id === speaker.characterId))
        throw unavailable()
    } else if (!['user', 'narrator', 'npc'].includes(String(speaker.kind))) throw unavailable()
    const key = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const cached = loadMessage(messageId).meta.ttsCache?.find((item) => item.key === key)
    if (cached) return Response.json({ kind: 'audio', url: cached.url })
    const previous = db
      .select()
      .from(roomEvents)
      .where(eq(roomEvents.roomId, roomId))
      .all()
      .find((e) => e.type === 'room.asset' && e.payload.voiceKey === key)
    if (previous) return Response.json(previous.payload.result)
    const pendingKey = `${roomId}:${key}`
    const existing = pending.get(pendingKey)
    if (existing) return copyResponse(await existing)
    const release = reserveUsage(room, member.userId)
    const work = (async () => {
      const upstream = await forwardExtension(
        'audio',
        new Request('http://room/api/ext/audio/tts/line', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }),
      )
      const response = new Response(upstream.body, { status: upstream.status, headers: [...upstream.headers] })
      if (!response.ok) return response
      const result: unknown = await response.json()
      const url =
        result && typeof result === 'object' && 'url' in result && typeof result.url === 'string'
          ? result.url
          : undefined
      const saved = db.transaction(() => {
        if (url) {
          const message = loadMessage(messageId)
          const existing = db
            .select()
            .from(messages)
            .where(eq(messages.chatId, room.chatId))
            .all()
            .some((m) => m.meta.ttsCache?.some((cache) => cache.url === url))
          db.update(messages)
            .set({ meta: { ...message.meta, ttsCache: [...(message.meta.ttsCache ?? []), { key, url }] } })
            .where(eq(messages.id, messageId))
            .run()
          if (!existing)
            db.insert(roomUsage)
              .values({ id: newId(), roomId, userId: member.userId, kind: 'tts', createdAt: Date.now() })
              .run()
        }
        return event(room, 'room.asset', member.userId, { voiceKey: key, result, ...(url ? { url } : {}) }, messageId)
      })
      publish(saved)
      return Response.json(result)
    })()
    pending.set(pendingKey, work)
    try {
      return copyResponse(await work)
    } finally {
      release()
      pending.delete(pendingKey)
    }
  })
}
