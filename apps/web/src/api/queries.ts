import type { ChatPage, MessageDTO } from '@ai-parter/shared'
import { type InfiniteData, type QueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api } from './client'

/** 所有缓存的 key 集中在这里，避免拼错 */
export const keys = {
  characters: ['characters'] as const,
  character: (id: string) => ['character', id] as const,
  chats: (characterId: string) => ['chats', characterId] as const,
  chat: (chatId: string) => ['chat', chatId] as const,
  apiPresets: ['apiPresets'] as const,
  personas: ['personas'] as const,
}

export const useCharacters = () => useQuery({ queryKey: keys.characters, queryFn: api.listCharacters })

export const useCharacter = (id: string | null) =>
  useQuery({ queryKey: keys.character(id ?? ''), queryFn: () => api.getCharacter(id as string), enabled: !!id })

export const useChats = (characterId: string | null) =>
  useQuery({
    queryKey: keys.chats(characterId ?? ''),
    queryFn: () => api.listChats(characterId as string),
    enabled: !!characterId,
  })

export const useApiPresets = () => useQuery({ queryKey: keys.apiPresets, queryFn: api.listApiPresets })
export const usePersonas = () => useQuery({ queryKey: keys.personas, queryFn: api.listPersonas })

/**
 * 会话消息分页加载。pages[0] 是最新的一页，往后是越来越旧的页。
 * 消息只会被我们自己的操作改变，所以不自动重新拉取（staleTime: Infinity）。
 */
export const useChatPages = (chatId: string | null) =>
  useInfiniteQuery({
    queryKey: keys.chat(chatId ?? ''),
    queryFn: ({ pageParam }) => api.getChatPage(chatId as string, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.messages[0]?.id : undefined),
    enabled: !!chatId,
    staleTime: Number.POSITIVE_INFINITY,
  })

type ChatCache = InfiniteData<ChatPage, string | undefined>

/** 把分页数据拍平成从旧到新的一个数组 */
export function flattenPages(data: { pages: ChatPage[] } | undefined): MessageDTO[] {
  if (!data) return []
  return [...data.pages].reverse().flatMap((p) => p.messages)
}

/**
 * 把新消息接到缓存里的对话末尾。
 * 规则和后端消息树一致：找到新消息的父节点，父节点之后的内容全部换成新消息。
 * 所以「发送」是追加，「重新生成」是替换掉旧回复，都用这一个函数。
 * 父节点不在缓存里时返回 false，调用方应该重新拉取。
 */
export function applyNewMessage(qc: QueryClient, chatId: string, msg: MessageDTO): boolean {
  let ok = false
  qc.setQueryData<ChatCache>(keys.chat(chatId), (data) => {
    if (!data) return data
    for (let k = 0; k < data.pages.length; k++) {
      const page = data.pages[k] as ChatPage
      const i = page.messages.findIndex((m) => m.id === msg.parentId)
      if (i < 0) continue
      ok = true
      const updated: ChatPage = { ...page, messages: [...page.messages.slice(0, i + 1), msg] }
      // 比第 k 页更新的页都在父节点之后，整页丢掉
      return { pages: [updated, ...data.pages.slice(k + 1)], pageParams: data.pageParams.slice(k) }
    }
    return data
  })
  return ok
}

/** 用新数据替换缓存里的某条消息（编辑完成、生成结束时用） */
export function replaceMessage(qc: QueryClient, chatId: string, msg: MessageDTO) {
  qc.setQueryData<ChatCache>(keys.chat(chatId), (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((p) => ({ ...p, messages: p.messages.map((m) => (m.id === msg.id ? msg : m)) })),
        }
      : data,
  )
}

/** 把缓存里的「后端正在生成」标记清掉 */
export function markIdle(qc: QueryClient, chatId: string) {
  qc.setQueryData<ChatCache>(keys.chat(chatId), (data) =>
    data ? { ...data, pages: data.pages.map((p) => ({ ...p, generating: false })) } : data,
  )
}

/**
 * 消息树结构变了（切换 swipe、删除消息）：丢掉已加载的所有页，重新拉最新一页。
 * 不能用普通的 refetch，因为旧页的分页参数可能已经不在新路径上了。
 */
export function resetChat(qc: QueryClient, chatId: string) {
  return qc.resetQueries({ queryKey: keys.chat(chatId) })
}
