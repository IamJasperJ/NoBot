import type { MessageDTO } from '@ai-parter/shared'

export type CommandEvent =
  | { type: 'onUser'; chatId: string; depth: number }
  | { type: 'onAi'; chatId: string; depth: number; messages: MessageDTO[] }
  | { type: 'onNewChat'; chatId: string; depth: number }
  | { type: 'onGroupMemberDraft'; chatId: string; depth: number }
const listeners = new Set<(event: CommandEvent) => void>()
export function onCommandEvent(fn: (event: CommandEvent) => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
export function emitCommandEvent(event: CommandEvent) {
  for (const fn of listeners) fn(event)
}
