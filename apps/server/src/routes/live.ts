import { randomUUID } from 'node:crypto'
import { type LiveEnvelope, notificationCursor } from '@nobot/shared'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { db } from '../db/client'
import { roomEvents } from '../db/schema'
import { HttpError } from '../errors'
import { t } from '../i18n'
import { validate } from '../lib/validate'
import { authenticatedSession } from '../services/auth'
import * as generation from '../services/generation/generation'
import { liveHub } from '../services/live/hub'
import { asHost, listRooms, membership, projectRoomEvent, roomRow, unavailable } from '../services/rooms'
import { roomPayload } from '../services/rooms/dto'
import { roomActivity } from '../services/rooms/trpg'
import { friendIds, latestNotificationCursor, replayNotifications, unreadCount } from '../services/social'
import { presence } from '../services/social/presence'
import { currentUser } from '../user-context'

function publishRoomDeparture(topic: string, userId: string) {
  if (!topic.startsWith('room:') || liveHub.topicUsers(topic).includes(userId)) return
  liveHub.publishToTopic(topic, {
    type: 'room.member',
    topic,
    data: {
      roomId: topic.slice(5),
      type: 'room.member',
      actorId: userId,
      payload: { action: 'presence', userId, inRoom: false },
      createdAt: Date.now(),
    },
  })
}

export const liveRoutes = new Hono()
  .post(
    '/topics',
    validate(
      'json',
      z.object({
        connectionId: z.string(),
        topic: z.string().regex(/^room:[^:]+$/),
        since: z.number().int().min(0).default(0),
        unsubscribe: z.boolean().default(false),
      }),
    ),
    (c) => {
      const { connectionId, topic, since, unsubscribe } = c.req.valid('json')
      const connection = liveHub.connection(currentUser().id, connectionId)
      if (!connection) throw unavailable()
      if (unsubscribe) {
        connection.topics.delete(topic)
        publishRoomDeparture(topic, currentUser().id)
        presence.tick()
        return c.json({ ok: true })
      }
      const viewerId = currentUser().id
      const { room, member } = membership(topic.slice(5))
      roomActivity(room, viewerId)
      asHost(room, () => {
        const all = db.select().from(roomEvents).where(eq(roomEvents.roomId, room.id)).orderBy(roomEvents.seq).all()
        connection.topics.add(topic)
        const latest = all.at(-1)?.seq ?? 0
        if (since > latest || (all.length && since < all[0]!.seq - 1))
          connection.send({ type: 'room.resync', topic, data: { roomId: room.id, seq: latest } })
        else
          for (const row of all.filter((row) => row.seq > since))
            connection.send({
              type: projectRoomEvent(row, viewerId, room).type,
              topic,
              data: projectRoomEvent(row, viewerId, room),
            })
        const job = generation.getJob(room.chatId)
        if (job && member.role !== 'spectator') {
          let messageId: string | undefined,
            index = 0
          const dispose = generation.subscribe(job, (e) => {
            if (e.type === 'start') messageId = e.assistantMessage.id
            connection.send({
              type: 'room.generation',
              topic,
              data: {
                roomId: room.id,
                type: 'room.generation',
                actorId: room.hostUserId,
                payload: roomPayload({ ...e, messageId, index: index++ }, viewerId, room.hostUserId),
                createdAt: Date.now(),
              },
            })
          })
          dispose()
        }
      })
      presence.tick()
      liveHub.publishToTopic(topic, {
        type: 'room.member',
        topic,
        data: {
          roomId: room.id,
          type: 'room.member',
          actorId: currentUser().id,
          payload: { action: 'presence', userId: currentUser().id, inRoom: true },
          createdAt: Date.now(),
        },
      })
      return c.json({ ok: true })
    },
  )
  .post('/activity', (c) => {
    const userId = currentUser().id
    presence.activity(userId)
    // 房间活动与全局活动共用实际交互心跳，空闲连接不会永久阻塞全员就绪。
    for (const room of listRooms()
      .filter((r) => liveHub.topicUsers(`room:${r.id}`).includes(userId))
      .map((r) => roomRow(r.id)))
      roomActivity(room, userId)
    return c.json({ ok: true })
  })
  .get('/', (c) => {
    const cursor = c.req.header('Last-Event-ID') ?? c.req.query('since')
    if (cursor !== undefined && !notificationCursor.safeParse(cursor).success)
      throw new HttpError(400, 'INVALID_CURSOR', t('通知游标无效'))
    const userId = currentUser().id
    return streamSSE(c, async (stream) => {
      const connectionId = randomUUID()
      let finish!: () => void
      const done = new Promise<void>((resolve) => {
        finish = resolve
      })
      let disposed = false
      let queue = Promise.resolve()
      const send = (event: LiveEnvelope) => {
        queue = queue
          .then(async () => {
            if (!disposed)
              await stream.writeSSE({
                event: event.type,
                data: JSON.stringify(event),
                ...(event.id ? { id: event.id } : {}),
              })
          })
          .catch(() => cleanup())
      }
      const registration = liveHub.register(
        userId,
        send,
        () => {
          cleanup()
          void stream.close()
        },
        connectionId,
      )
      const cleanup = () => {
        if (disposed) return
        disposed = true
        clearInterval(heartbeat)
        const topics = [...(liveHub.connection(userId, connectionId)?.topics ?? [])]
        registration.dispose()
        for (const topic of topics) publishRoomDeparture(topic, userId)
        presence.disconnect(userId, connectionId)
        finish()
      }
      const heartbeat = setInterval(() => {
        // 长连接也必须及时失效，不能只在最初建立连接时验证会话。
        try {
          authenticatedSession(c)
          send({ type: 'ping', topic: `user:${userId}`, data: { serverTime: Date.now() } })
        } catch {
          cleanup()
          void stream.close()
        }
      }, 15000)
      stream.onAbort(cleanup)
      c.req.raw.signal.addEventListener('abort', cleanup, { once: true })
      try {
        await stream.write('retry: 3000\n\n')
        send({
          type: 'hello',
          topic: `user:${userId}`,
          data: {
            connectionId,
            serverTime: Date.now(),
            cursor: latestNotificationCursor(userId),
            unreadCount: unreadCount(userId),
            presence: presence.getPresence(userId, friendIds(userId)),
          },
        })
        if (cursor) {
          const replay = replayNotifications(userId, cursor)
          if (replay.length > 200)
            send({ type: 'resync', topic: `user:${userId}`, data: { cursor: latestNotificationCursor(userId) } })
          else
            for (const item of replay) send({ type: 'notification', topic: `user:${userId}`, id: item.id, data: item })
        }
        presence.connect(userId, connectionId)
        if (c.req.raw.signal.aborted) cleanup()
        await done
      } finally {
        cleanup()
        c.req.raw.signal.removeEventListener('abort', cleanup)
      }
    })
  })
