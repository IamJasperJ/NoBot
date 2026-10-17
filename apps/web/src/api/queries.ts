import type { ChatPage, MessageDTO } from '@ai-parter/shared'
import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { api } from './client'

/** 所有缓存的 key 集中在这里，避免拼错。改了数据后用 invalidateQueries 刷新对应的 key */
export const keys = {
  backgrounds: ['backgrounds'] as const,
  backgroundSettings: ['backgroundSettings'] as const,
  connections: ['connections'] as const,
  presets: ['presets'] as const,
  playPresets: ['playPresets'] as const,
  sprites: (characterId: string) => ['sprites', characterId] as const,
  bookmarks: (chatId: string) => ['bookmarks', chatId] as const,
  personas: ['personas'] as const,
  characters: ['characters'] as const,
  character: (id: string) => ['character', id] as const,
  lorebooks: ['lorebooks'] as const,
  lorebook: (id: string) => ['lorebook', id] as const,
  worldInfoSettings: ['worldInfoSettings'] as const,
  groups: ['groups'] as const,
  group: (id: string) => ['group', id] as const,
  chats: (owner: { characterId?: string; groupId?: string }) => ['chats', owner.characterId ?? owner.groupId] as const,
  chat: (chatId: string) => ['chat', chatId] as const,
  logs: (chatId?: string) => ['logs', chatId ?? 'all'] as const,
  log: (id: string) => ['log', id] as const,
  extensions: ['extensions'] as const,
  tools: ['tools'] as const,
}

/** 自动选择后刷新聊天缓存，让背景和设置面板立即同步。 */
export function useAutoBackground() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.autoBackground,
    onSuccess: async (_result, chatId) => {
      await qc.invalidateQueries({ queryKey: keys.chat(chatId) })
    },
  })
}

export const useBackgrounds = () => useQuery({ queryKey: keys.backgrounds, queryFn: api.listBackgrounds })
export const useBackgroundSettings = () =>
  useQuery({ queryKey: keys.backgroundSettings, queryFn: api.getBackgroundSettings })

export const useConnections = () => useQuery({ queryKey: keys.connections, queryFn: api.listConnections })
export const usePresets = () => useQuery({ queryKey: keys.presets, queryFn: api.listPresets })
export const usePlayPresets = () => useQuery({ queryKey: keys.playPresets, queryFn: api.listPlayPresets })
/** 会话的书签（消息上的小旗子、会话设置里的书签列表共用） */
export const useBookmarks = (chatId: string) =>
  useQuery({ queryKey: keys.bookmarks(chatId), queryFn: () => api.listBookmarks(chatId), staleTime: 30_000 })

export const useSprites = (characterId: string | null | undefined) =>
  useQuery({
    queryKey: keys.sprites(characterId ?? ''),
    queryFn: () => api.listSprites(characterId as string),
    enabled: !!characterId,
  })
export const usePersonas = () => useQuery({ queryKey: keys.personas, queryFn: api.listPersonas })
export const useCharacters = () => useQuery({ queryKey: keys.characters, queryFn: api.listCharacters })
export const useCharacter = (id: string | null) =>
  useQuery({ queryKey: keys.character(id ?? ''), queryFn: () => api.getCharacter(id as string), enabled: !!id })
export const useLorebooks = () => useQuery({ queryKey: keys.lorebooks, queryFn: api.listLorebooks })
export const useLorebook = (id: string | null) =>
  useQuery({ queryKey: keys.lorebook(id ?? ''), queryFn: () => api.getLorebook(id as string), enabled: !!id })
export const useWorldInfoSettings = () =>
  useQuery({ queryKey: keys.worldInfoSettings, queryFn: api.getWorldInfoSettings })
export const useGroups = () => useQuery({ queryKey: keys.groups, queryFn: api.listGroups })
export const useExtensions = () => useQuery({ queryKey: keys.extensions, queryFn: api.listExtensions })
export const useTools = () => useQuery({ queryKey: keys.tools, queryFn: api.listTools })
export const useLogs = (chatId?: string) =>
  useQuery({ queryKey: keys.logs(chatId), queryFn: () => api.listLogs(chatId ? { chatId } : {}) })
export const useLog = (id: string | null) =>
  useQuery({ queryKey: keys.log(id ?? ''), queryFn: () => api.getLog(id as string), enabled: !!id })

/** 某个角色或群组的会话列表 */
export const useChats = (owner: { characterId?: string; groupId?: string } | null) =>
  useQuery({
    queryKey: keys.chats(owner ?? {}),
    queryFn: () => api.listChats(owner ?? {}),
    enabled: !!(owner?.characterId || owner?.groupId),
  })

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

/**
 * 只刷新会话页里由整条路径算出来的字段（舞台、变量、生效的玩法预设），不动已加载的消息。
 * 生成完成、编辑消息之后调用：这些操作只替换了单条消息，但舞台和变量是沿路径累加的。
 */
export async function refreshChatState(qc: QueryClient, chatId: string) {
  try {
    const latest = await api.getChatPage(chatId)
    qc.setQueryData<ChatCache>(keys.chat(chatId), (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((p) => ({
              ...p,
              stage: latest.stage,
              vars: latest.vars,
              playPresetId: latest.playPresetId,
            })),
          }
        : data,
    )
  } catch {
    // 只是附带刷新，失败了不打扰用户；下次打开会话时会拿到最新数据
  }
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
  // 分支变了（swipe、移动、删除、切换书签分支）：书签的「是否在当前分支」也要跟着刷新
  void qc.invalidateQueries({ queryKey: keys.bookmarks(chatId) })
  return qc.resetQueries({ queryKey: keys.chat(chatId) })
}
