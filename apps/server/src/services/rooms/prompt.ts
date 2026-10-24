import { and, eq } from 'drizzle-orm'
import { systemDatabase } from '../../db/system-client'
import { rooms } from '../../db/system-schema'
import { currentUser } from '../../user-context'
import { loadPath } from '../chats'
import { members } from './index'
import { turnState } from './turns'

export function multiplayerPrompt(chatId: string, leafId: string | null) {
  const room = systemDatabase()
    .select()
    .from(rooms)
    .where(and(eq(rooms.chatId, chatId), eq(rooms.hostUserId, currentUser().id)))
    .get()
  if (!room) return undefined
  const players = members(room.id).filter((m) => m.role !== 'spectator')
  const history = loadPath(leafId)
  const lastAi = history.findLastIndex((m) => m.role === 'assistant')
  const turn = turnState(room.id)
  const names =
    turn.running && turn.inputPlayers?.length
      ? turn.inputPlayers
      : [
          ...new Set(
            history
              .slice(lastAi + 1)
              .filter((m) => m.role === 'user' && m.meta.channel !== 'ooc')
              .map((m) => m.meta.name)
              .filter((n): n is string => !!n),
          ),
        ]
  const list = (n: string[]) => (n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`)
  const descriptions = players.map((m) => `${m.personaName}: ${m.personaDescription}`).join('\n')
  const replyTo = turnState(room.id).replyTo
  return {
    roomId: room.id,
    user: list(names.length ? names : players.map((m) => m.personaName)),
    players: list(players.map((m) => m.personaName)),
    description: descriptions,
    note: `This is a multiplayer scene with human players:\n${descriptions}\nDo not speak or act for the human players. Address players by name when replying to someone specific. Write in the same language as the conversation.${replyTo ? ` Reply primarily to ${replyTo}'s latest message.` : ''}`,
  }
}
