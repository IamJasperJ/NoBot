import type { QueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { resetChat } from '../api/queries'
import { runGeneration } from '../features/chat/generate'
import { mergeQuickReplySets } from '../quick-replies/logic'
import { useCommandDrafts } from '../stores/commandInput'
import { toast } from '../stores/toast'
import { emitCommandEvent } from './events'
import type { CommandContext } from './run'

export async function activeQuickReplySets(chatId: string | null) {
  const state = await api.listQuickReplySets()
  if (!chatId) return mergeQuickReplySets(state.sets, state.setIds)
  const page = await api.getChatPage(chatId)
  const characters = page.group
    ? await Promise.all(page.group.members.map((m) => api.getCharacter(m.characterId)))
    : page.chat.characterId
      ? [await api.getCharacter(page.chat.characterId)]
      : []
  return mergeQuickReplySets(
    state.sets,
    state.setIds,
    ...characters.map((c) => c.quickReplySetIds),
    page.chat.quickReplySetIds,
  )
}
export function createCommandContext(qc: QueryClient, chatId: string | null, automationDepth = 0): CommandContext {
  return {
    chatId,
    api,
    automationDepth,
    generate: (id, input) => runGeneration(qc, id, input, automationDepth),
    refresh: async () => {
      if (chatId) await resetChat(qc, chatId)
      await qc.invalidateQueries({ queryKey: ['quickReplies'] })
    },
    getInput: () => (chatId ? (useCommandDrafts.getState().drafts[chatId] ?? '') : ''),
    setInput: (text) => {
      if (chatId) useCommandDrafts.getState().set(chatId, text)
    },
    notify: (text) => {
      if (text) toast.info(text)
    },
    prompt: async (text) => window.prompt(text),
    getActiveSets: () => activeQuickReplySets(chatId),
  }
}
export function notifyUserSent(ctx: CommandContext) {
  if (ctx.chatId) emitCommandEvent({ type: 'onUser', chatId: ctx.chatId, depth: ctx.automationDepth ?? 0 })
}
