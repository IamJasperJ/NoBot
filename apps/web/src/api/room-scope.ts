import type { RoomDTO } from '@nobot/shared'
import { isMiniApp } from '../miniapp/context'

const scopes = new Map<string, { roomId: string; role?: RoomDTO['myRole']; entities: Set<string> }>()
/** 打开房间前登记，关闭最后一个视图时撤销；成员权限仍由服务器逐次校验。 */
export function setRoomScope(room: Pick<RoomDTO, 'id' | 'chatId'> & Partial<Pick<RoomDTO, 'myRole'>>) {
  const replaced: string[] = []
  // 房主转让会更换聊天 ID，旧会话已恢复为个人会话，不能继续路由到房间。
  for (const [chatId, scope] of scopes)
    if (scope.roomId === room.id && chatId !== room.chatId) {
      replaced.push(chatId)
      scopes.delete(chatId)
    }
  const existing = scopes.get(room.chatId)
  if (!existing || existing.roomId !== room.id)
    scopes.set(room.chatId, { roomId: room.id, role: room.myRole, entities: new Set() })
  else existing.role = room.myRole
  return replaced
}
export function removeRoomScope(chatId?: string) {
  if (chatId) scopes.delete(chatId)
  else scopes.clear()
}
export function scopeForChat(chatId: string) {
  return scopes.get(chatId)?.roomId
}
export function scopedApiPath(path: string) {
  if (path.includes('/rooms/')) return path
  const chat = /^\/api\/chats\/([^/?]+)/.exec(path)
  if (chat) {
    const scope = scopes.get(chat[1]!)
    if (scope?.role === 'owner' && !isMiniApp() && !/\/(generate|abort|roll|check)(?:\?|$)/.test(path)) return path
    return scope ? `/api/rooms/${encodeURIComponent(scope.roomId)}/scope${path.slice(4)}` : path
  }
  const voiceChat = /^\/api\/ext\/audio\/tts\/chat\/([^/?]+)$/.exec(path)
  if (voiceChat) {
    const scope = scopes.get(voiceChat[1]!)
    if (scope && (scope.role !== 'owner' || isMiniApp()))
      return `/api/rooms/${encodeURIComponent(scope.roomId)}/scope${path.slice(4)}`
  }
  const entity = /^\/api\/(?:messages|characters|groups)\/([^/?]+)/.exec(path)
  if (entity)
    for (const scope of scopes.values())
      if (
        (scope.role !== 'owner' || isMiniApp() || path.startsWith('/api/messages/')) &&
        scope.entities.has(entity[1]!)
      )
        return `/api/rooms/${encodeURIComponent(scope.roomId)}/scope${path.slice(4)}`
  return path
}
/** 只重写 API 返回的资源 URL，并登记消息与角色 id，保持现有组件的调用方式。 */
export function scopeRoomData<T>(value: T, roomId: string): T {
  const scope = [...scopes.values()].find((s) => s.roomId === roomId)
  function walk(v: unknown): unknown {
    if (typeof v === 'string' && v.startsWith('/api/assets/'))
      return `/api/rooms/${encodeURIComponent(roomId)}/scope${v.slice(4)}`
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>
      if (typeof obj.id === 'string') scope?.entities.add(obj.id)
      if (typeof obj.characterId === 'string') scope?.entities.add(obj.characterId)
      if (typeof obj.groupId === 'string') scope?.entities.add(obj.groupId)
      return Object.fromEntries(Object.entries(obj).map(([k, item]) => [k, walk(item)]))
    }
    return v
  }
  return walk(value) as T
}

/** 访客只能使用房间快照，不能查询房主的个人设置。 */
export function isRoomGuest(chatId: string | null | undefined) {
  const scope = chatId ? scopes.get(chatId) : undefined
  return isMiniApp() || (!!scope && scope.role !== 'owner')
}
