import { randomUUID } from 'node:crypto'
import { type LiveEnvelope, notificationCursor } from '@nobot/shared'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { HttpError } from '../errors'
import { t } from '../i18n'
import { authenticatedSession } from '../services/auth'
import { liveHub } from '../services/live/hub'
import { friendIds, latestNotificationCursor, replayNotifications, unreadCount } from '../services/social'
import { presence } from '../services/social/presence'
import { currentUser } from '../user-context'

export const liveRoutes = new Hono()
  .post('/activity', (c) => {
    presence.activity(currentUser().id)
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
      const registration = liveHub.register(userId, send, () => {
        cleanup()
        void stream.close()
      })
      const cleanup = () => {
        if (disposed) return
        disposed = true
        clearInterval(heartbeat)
        registration.dispose()
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
