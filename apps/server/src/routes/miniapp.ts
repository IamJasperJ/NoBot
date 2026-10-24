import { and, eq, gt } from 'drizzle-orm'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { db } from '../db/client'
import { channelBindings, channelMiniAppTokens } from '../db/schema'
import { authenticatedSession } from '../services/auth'
import { listBackgrounds } from '../services/backgrounds/backgrounds'
import { getCharacter } from '../services/characters'
import { getChatRow } from '../services/chats'
import { resolvePlayPreset } from '../services/generation/stage'
import { liveHub } from '../services/live/hub'
import { asHost, membership, roomDetail } from '../services/rooms'
import { stageViewPlay } from '../services/rooms/view'
import { scopeDenied } from '../services/scoped-session'
import { chatAssetAllowed } from '../services/scoped-session-assets'
import { currentUser } from '../user-context'

export const miniAppRoutes = new Hono()
  .get('/context', (c) => {
    const { session } = authenticatedSession(c)
    const scope = session.scope
    if (!scope) scopeDenied()
    const start = c.req.query('start')
    const checkStart = (chatId: string) => {
      if (!start) return
      const token = db
        .select()
        .from(channelMiniAppTokens)
        .where(and(eq(channelMiniAppTokens.token, start), gt(channelMiniAppTokens.expiresAt, Date.now())))
        .get()
      if (!token) scopeDenied()
      const matches = db
        .select()
        .from(channelBindings)
        .where(
          and(
            eq(channelBindings.accountId, token.accountId),
            eq(channelBindings.chatId, chatId),
            eq(channelBindings.state, 'active'),
          ),
        )
        .all()
      if (!matches.some((b) => (token.bindingId ? b.id === token.bindingId : b.scope === 'private'))) scopeDenied()
    }
    if (scope.kind === 'room') {
      const { room: row } = membership(scope.roomId)
      asHost(row, () => checkStart(row.chatId))
      const room = roomDetail(scope.roomId)
      return c.json({ scope, chatId: room.chatId, roomId: room.id, room })
    }
    checkStart(scope.chatId)
    const chat = getChatRow(scope.chatId)
    const preset = resolvePlayPreset(chat.id)
    const character = chat.characterId ? getCharacter(chat.characterId) : null
    const backgrounds = listBackgrounds()
      .filter((b) => chatAssetAllowed(chat, b.url))
      .map((b) => ({ ...b, description: '', folderIds: [] }))
    return c.json({
      scope,
      chatId: chat.id,
      roomId: null,
      preset: { ...preset, data: stageViewPlay(chat.id) },
      character,
      backgrounds,
    })
  })
  .get('/events', (c) => {
    const { session } = authenticatedSession(c)
    const scope = session.scope
    if (!scope) scopeDenied()
    const userId = currentUser().id
    // 只发送失效通知，不复用带全局通知与在线好友信息的 /live 流。
    return streamSSE(c, async (stream) => {
      let finish!: () => void
      const done = new Promise<void>((resolve) => {
        finish = resolve
      })
      let disposed = false
      let timer: ReturnType<typeof setInterval> | undefined
      const close = () => {
        if (!disposed) {
          disposed = true
          if (timer) clearInterval(timer)
          registration.dispose()
          finish()
        }
      }
      const registration = liveHub.register(
        userId,
        (event) => {
          try {
            authenticatedSession(c, false)
            if (scope.kind === 'room') membership(scope.roomId)
            const allowed =
              scope.kind === 'room' ? event.topic === `room:${scope.roomId}` : event.topic === `chat:${scope.chatId}`
            if (allowed) void stream.writeSSE({ event: 'change', data: '{}' }).catch(close)
          } catch {
            close()
          }
        },
        close,
      )
      if (scope.kind === 'room')
        await registration.join(`room:${scope.roomId}`, () => {
          membership(scope.roomId)
          return true
        })
      timer = setInterval(() => {
        try {
          authenticatedSession(c, false)
          if (scope.kind === 'room') membership(scope.roomId)
          // 生成过程与后台媒体也会刷新，重连无需全局游标或历史通知。
          void stream.writeSSE({ event: 'change', data: '{}' }).catch(close)
        } catch {
          close()
        }
      }, 15000)
      stream.onAbort(close)
      if (c.req.raw.signal.aborted) close()
      try {
        await stream.writeSSE({ event: 'ready', data: '{}' })
        await done
      } finally {
        close()
      }
    })
  })
