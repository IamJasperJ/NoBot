import type { QuickReply, QuickReplySet } from '@nobot/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { api } from '../api/client'
import { useCharacter, useChatPages } from '../api/queries'
import { createCommandContext } from '../commands/context'
import { mergeQuickReplySets, runQuickReply } from './logic'

export const quickReplyKeys = ['quickReplies'] as const
export const useQuickReplySets = () => useQuery({ queryKey: quickReplyKeys, queryFn: api.listQuickReplySets })
export function useActiveQuickReplies(chatId: string | null) {
  const state = useQuickReplySets()
  const page = useChatPages(chatId).data?.pages[0]
  const character = useCharacter(page?.chat?.characterId ?? null)
  const groupCharacters = useQuery({
    queryKey: ['quickReplyCharacters', page?.group?.members.map((m) => m.characterId)],
    queryFn: () => Promise.all((page?.group?.members ?? []).map((m) => api.getCharacter(m.characterId))),
    enabled: !!page?.group,
  })
  const sets = mergeQuickReplySets(
    state.data?.sets ?? [],
    state.data?.setIds,
    ...(page?.group ? (groupCharacters.data ?? []) : character.data ? [character.data] : []).map(
      (c) => c.quickReplySetIds,
    ),
    page?.chat?.quickReplySetIds,
  )
  return {
    ...state,
    sets,
    data: sets.flatMap((set) => set.buttons.filter((qr) => !qr.isHidden).map((qr) => ({ ...qr, set }))),
  }
}
export function useQuickReplyMutations() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries()
  return {
    create: useMutation({ mutationFn: api.createQuickReplySet, onSuccess: refresh }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: Parameters<typeof api.updateQuickReplySet>[1] }) =>
        api.updateQuickReplySet(id, input),
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: api.deleteQuickReplySet, onSuccess: refresh }),
    global: useMutation({ mutationFn: api.setGlobalQuickReplySets, onSuccess: refresh }),
    chat: useMutation({
      mutationFn: ({ chatId, setIds }: { chatId: string; setIds: string[] }) =>
        api.updateChat(chatId, { quickReplySetIds: setIds }),
      onSuccess: refresh,
    }),
    character: useMutation({
      mutationFn: ({ characterId, setIds }: { characterId: string; setIds: string[] }) =>
        api.updateCharacter(characterId, { quickReplySetIds: setIds }),
      onSuccess: refresh,
    }),
  }
}

export function useRunQuickReply(chatId: string) {
  const qc = useQueryClient()
  return useCallback(
    (qr: QuickReply, set?: QuickReplySet): Promise<string> => runQuickReply(qr, createCommandContext(qc, chatId), set),
    [qc, chatId],
  )
}
