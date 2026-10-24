import { z } from 'zod'
import { userHandleSchema } from './auth'

export const friendRequestInput = z.object({ handle: userHandleSchema })
export const blockUserInput = z.object({ userId: z.string().min(1).max(128) })
export const presenceInput = z.object({ status: z.enum(['auto', 'dnd', 'invisible']) })
export const notificationCursor = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((s) => Number.isSafeInteger(Number(s)))
export const notificationPageInput = z.object({
  before: notificationCursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export const notificationReadInput = z.object({ ids: z.array(notificationCursor).max(200).optional() })
export interface PublicUserDTO {
  id: string
  handle: string
  name: string
}
export type PresenceStatus = 'online' | 'away' | 'offline' | 'dnd'
export interface PresenceDTO {
  status: PresenceStatus
  currentRoom?: { id: string; name: string }
}
export interface FriendDTO extends PublicUserDTO {
  presence: PresenceDTO
}
export interface FriendRequestDTO {
  user: PublicUserDTO
  createdAt: number
}
export interface FriendsDTO {
  friends: FriendDTO[]
  incoming: FriendRequestDTO[]
  outgoing: FriendRequestDTO[]
}
export type NotificationType = 'friend.request' | 'friend.accepted' | (string & {})
export interface NotificationDTO {
  id: string
  type: NotificationType
  actorId: string | null
  payload: Record<string, unknown>
  createdAt: number
  readAt: number | null
  dismissedAt: number | null
}
export interface NotificationPage {
  items: NotificationDTO[]
  nextCursor: string | null
}
export interface LiveEnvelope {
  id?: string
  type: string
  topic: string
  data: unknown
}
export type LiveEvent =
  | { type: 'channel.account'; topic: string; data: import('./channels').ChannelAccountDTO }
  | { type: 'channel.request'; topic: string; data: import('./channels').ChannelRequestDTO | { id: string } }
  | { type: 'ping'; topic: string; data: { serverTime: number } }
  | {
      type: 'hello'
      topic: string
      data: {
        connectionId?: string
        serverTime: number
        cursor: string | null
        unreadCount: number
        presence: Record<string, PresenceDTO>
      }
    }
  | { type: 'presence'; topic: string; data: { userId: string; presence: PresenceDTO } }
  | { type: 'notification'; topic: string; id: string; data: NotificationDTO }
  | { type: 'notification.read'; topic: string; data: { unreadCount: number } }
  | { type: 'friends.changed'; topic: string; data: Record<string, never> }
  | { type: 'resync'; topic: string; data: { cursor: string | null } }
