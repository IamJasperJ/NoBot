import { AsyncLocalStorage } from 'node:async_hooks'
import { and, eq } from 'drizzle-orm'
import { db, newId } from '../../db/client'
import { roomUsage } from '../../db/schema'
import { systemDatabase } from '../../db/system-client'
import { rooms } from '../../db/system-schema'
import { currentUser } from '../../user-context'
import { checkWritable, event, findRoom, publish, reserveUsage } from './index'

const actors = new AsyncLocalStorage<string>()
/** 生成派生的异步生图沿用真正触发者，不能把 runAsUser 后的房主误认为付费触发人。 */
export function runAsRoomActor<T>(userId: string, fn: () => T) {
  return actors.run(userId, fn)
}
export function reserveChatAsset(chatId: string | undefined, kind: 'image' | 'tts') {
  if (!chatId) return undefined
  const room = systemDatabase()
    .select()
    .from(rooms)
    .where(and(eq(rooms.chatId, chatId), eq(rooms.hostUserId, currentUser().id)))
    .get()
  if (!room) return undefined
  const userId = actors.getStore() ?? currentUser().id
  checkWritable(room, userId)
  const release = reserveUsage(room, userId)
  return {
    release,
    saved: () => {
      if (!findRoom(room.id)) {
        release()
        return
      }
      const saved = db.transaction(() => {
        db.insert(roomUsage).values({ id: newId(), roomId: room.id, userId, kind, createdAt: Date.now() }).run()
        return event(room, 'room.asset', userId, { kind })
      })
      release()
      publish(saved)
    },
  }
}
