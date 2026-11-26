import { resolveBackgroundId } from '@nobot/core/stage'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { isMiniApp } from '../miniapp/context'
import { resetChat } from './chat-cache'
import { ApiRequestError, api } from './client'
import { keys } from './query-keys'
import { isRoomGuest } from './room-scope'
import { useRooms } from './rooms'

export {
  applyNewMessage,
  flattenPages,
  refreshChatState,
  replaceMessage,
  resetChat,
  setChatGenerating,
} from './chat-cache'
export { keys } from './query-keys'

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

export const useBackgrounds = (folderId?: string) =>
  useQuery({
    queryKey: folderId === undefined ? keys.backgrounds : [...keys.backgrounds, { folderId }],
    queryFn: () => api.listBackgrounds(folderId),
    enabled: !isMiniApp(),
  })
/** 房间背景来自裁剪后的聊天快照，个人背景库缓存保持独立。 */
export function useChatBackgrounds(chatId: string | null) {
  const own = useBackgrounds()
  const pages = useChatPages(chatId)
  return { ...own, data: pages.data?.pages[0]?.roomView?.backgrounds ?? own.data }
}
export const useBackgroundFolders = () =>
  useQuery({ queryKey: keys.backgroundFolders, queryFn: api.listBackgroundFolders })

/** 显示层只读取解析结果，优先级在 core 的纯函数内统一维护。 */
export function useResolvedBackgroundId(chatId: string | null) {
  const pages = useChatPages(chatId)
  const page = pages.data?.pages[0]
  const character = useCharacter(page?.chat.characterId ?? null)
  const settings = useBackgroundSettings()
  return resolveBackgroundId({
    backgroundId: page?.chat.backgroundId,
    backgroundPinned: page?.chat.backgroundPinned,
    stageBackgroundId: page?.stage?.scene.backgroundId,
    defaultBackgroundId: page?.chat.groupId ? page.group?.defaultBackgroundId : character.data?.defaultBackgroundId,
    globalId: page?.roomView ? page.roomView.globalBackgroundId : settings.data?.globalId,
  })
}
export const useBackgroundSettings = () =>
  useQuery({ queryKey: keys.backgroundSettings, queryFn: api.getBackgroundSettings, enabled: !isMiniApp() })

export const useProfiles = () => useQuery({ queryKey: keys.profiles, queryFn: api.listProfiles })
export const useChatProfile = (chatId: string | null) =>
  useQuery({
    queryKey: keys.chatProfile(chatId ?? ''),
    queryFn: () => api.getChatProfile(chatId!),
    enabled: !!chatId && !isRoomGuest(chatId),
  })

/** 配置组影响连接、角色绑定和会话摘要，保存后统一使相关缓存失效。 */
export function useProfileMutations() {
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries()
  return {
    create: useMutation({ mutationFn: api.createProfile, onSuccess: refresh }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: Parameters<typeof api.updateProfile>[1] }) =>
        api.updateProfile(id, input),
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: api.deleteProfile, onSuccess: refresh }),
    setDefault: useMutation({ mutationFn: api.setDefaultProfile, onSuccess: refresh }),
  }
}
export function useRegenerateCaption() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, chatId }: { id: string; chatId?: string }) => api.regenerateCaption(id, chatId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chat'] }),
  })
}

export const useConnections = () => useQuery({ queryKey: keys.connections, queryFn: api.listConnections })
export const usePresets = () => useQuery({ queryKey: keys.presets, queryFn: api.listPresets })
export function usePlayPresets(chatId?: string | null) {
  const rooms = useRooms()
  return useQuery({
    queryKey: keys.playPresets,
    queryFn: api.listPlayPresets,
    enabled: !chatId || (rooms.isSuccess && !isRoomGuest(chatId)),
  })
}
/** 会话的书签（消息上的小旗子、会话设置里的书签列表共用） */
export const useBookmarks = (chatId: string) =>
  useQuery({
    queryKey: keys.bookmarks(chatId),
    queryFn: () => api.listBookmarks(chatId),
    enabled: !isRoomGuest(chatId),
    staleTime: 30_000,
  })

export const useSprites = (characterId: string | null | undefined) =>
  useQuery({
    queryKey: keys.sprites(characterId ?? ''),
    queryFn: () => api.listSprites(characterId as string),
    enabled: !!characterId,
  })
export function usePersonas(chatId?: string | null) {
  const rooms = useRooms()
  return useQuery({
    queryKey: keys.personas,
    queryFn: api.listPersonas,
    enabled: !chatId || (rooms.isSuccess && !isRoomGuest(chatId)),
  })
}
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
export function useChatPages(chatId: string | null) {
  // 刷新页面时先登记房间 scope，再允许任何组件读取会话。
  const rooms = useRooms()
  const qc = useQueryClient()
  const query = useInfiniteQuery({
    queryKey: keys.chat(chatId ?? ''),
    queryFn: ({ pageParam }) => api.getChatPage(chatId as string, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.messages[0]?.id : undefined),
    enabled: !!chatId && rooms.isSuccess,
    staleTime: Number.POSITIVE_INFINITY,
    retry: (failureCount, error) => !isStaleChatCursor(error) && failureCount < 1,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.messages.some(
          (message) =>
            message.meta.cg?.some((cg) => cg.status === 'pending') || message.meta.spriteGeneration === 'pending',
        ),
      )
        ? 1000
        : false,
  })
  useEffect(() => {
    if (chatId && isStaleChatCursor(query.error)) void resetChat(qc, chatId)
  }, [qc, chatId, query.error])
  const completedSprites = query.data?.pages
    .flatMap((page) => page.messages)
    .filter((message) => message.meta.spriteGeneration === 'done' || message.meta.spriteGeneration === 'error')
    .map((message) => `${message.id}:${message.meta.spriteGeneration}`)
    .join(',')
  const completedCgs = query.data?.pages
    .flatMap((page) => page.messages)
    .flatMap((message) =>
      (message.meta.cg ?? []).filter((entry) => entry.status === 'done').map((entry) => entry.attachmentId),
    )
    .join(',')
  useEffect(() => {
    if (completedSprites) {
      void qc.invalidateQueries({ queryKey: ['sprites'] })
      void qc.invalidateQueries({ queryKey: ['vn-stage'] })
    }
  }, [qc, completedSprites])
  useEffect(() => {
    if (completedCgs) void qc.invalidateQueries({ queryKey: ['characterCgs'] })
  }, [qc, completedCgs])
  return query
}

export function isStaleChatCursor(error: unknown) {
  return error instanceof ApiRequestError && error.code === 'STALE_CHAT_CURSOR'
}

/** 背景删除会清空多种实体的引用，库操作后统一刷新这些缓存。 */
function useBackgroundLibraryMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await Promise.all(
        [
          'backgrounds',
          'backgroundFolders',
          'backgroundSettings',
          'chat',
          'character',
          'groups',
          'group',
          'lorebook',
        ].map((key) => qc.invalidateQueries({ queryKey: [key] })),
      )
    },
  })
}

export const useCreateBackgroundFolder = () => useBackgroundLibraryMutation(api.createBackgroundFolder)
export const useUpdateBackgroundFolder = () =>
  useBackgroundLibraryMutation(
    ({ id, input }: { id: string; input: Parameters<typeof api.updateBackgroundFolder>[1] }) =>
      api.updateBackgroundFolder(id, input),
  )
export const useDeleteBackgroundFolder = () => useBackgroundLibraryMutation(api.deleteBackgroundFolder)
export const useAddBackgroundsToFolder = () => useBackgroundLibraryMutation(api.addBackgroundsToFolder)
export const useRemoveBackgroundsFromFolder = () => useBackgroundLibraryMutation(api.removeBackgroundsFromFolder)
export const useBatchDeleteBackgrounds = () => useBackgroundLibraryMutation(api.batchDeleteBackgrounds)

export const useCharacterCgs = (characterId: string | null | undefined) =>
  useQuery({
    queryKey: keys.characterCgs(characterId ?? ''),
    queryFn: () => api.listCharacterCgs(characterId!),
    enabled: !!characterId,
  })

export function useSetAttachmentCg() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, isCg }: { id: string; isCg: boolean }) => api.setAttachmentCg(id, isCg),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['characterCgs'] }),
        qc.invalidateQueries({ queryKey: ['chat'] }),
      ])
    },
  })
}

export function useGenerateSprites(characterId: string) {
  return useMutation({
    mutationFn: (input: Parameters<typeof api.generateSprites>[1]) => api.generateSprites(characterId, input),
  })
}

/** 终态停止轮询，部分失败也要刷新，因为已成功的立绘已经入库。 */
export function useSpriteJob(characterId: string | null | undefined, jobId: string | null | undefined) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: keys.spriteJob(characterId ?? '', jobId ?? ''),
    queryFn: () => api.spriteJob(characterId!, jobId!),
    enabled: !!characterId && !!jobId,
    refetchInterval: (query) =>
      query.state.data && ['done', 'error'].includes(query.state.data.status) ? false : 1000,
  })
  const status = query.data?.status
  useEffect(() => {
    if (characterId && (status === 'done' || status === 'error')) {
      void qc.invalidateQueries({ queryKey: keys.sprites(characterId) })
      void qc.invalidateQueries({ queryKey: ['chat'] })
    }
  }, [qc, characterId, jobId, status])
  return query
}

export function useStartSpriteCutout(characterId: string) {
  return useMutation({
    mutationFn: (input: { ids: string[]; mode: Parameters<typeof api.startSpriteCutout>[2] }) =>
      api.startSpriteCutout(characterId, input.ids, input.mode),
  })
}

/** 终态停止轮询，部分失败也要刷新，因为已成功的立绘已经入库。 */
export function useSpriteCutoutJob(characterId: string | null | undefined, jobId: string | null | undefined) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['spriteCutoutJob', characterId ?? '', jobId ?? ''],
    queryFn: () => api.spriteCutoutJob(characterId!, jobId!),
    enabled: !!characterId && !!jobId,
    refetchInterval: (query) =>
      query.state.data && ['done', 'error'].includes(query.state.data.status) ? false : 1000,
  })
  const status = query.data?.status
  useEffect(() => {
    if (characterId && (status === 'done' || status === 'error')) {
      void qc.invalidateQueries({ queryKey: keys.sprites(characterId) })
      void qc.invalidateQueries({ queryKey: ['chat'] })
    }
  }, [qc, characterId, jobId, status])
  return query
}

export function useAiNameBackgrounds() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.aiNameBackgrounds,
    onSuccess: async (_result, input) => {
      if (input.apply !== false) await qc.invalidateQueries({ queryKey: keys.backgrounds })
    },
  })
}
