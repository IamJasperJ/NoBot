import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { ApiRequestError } from '../../api/client'
import { flattenPages, useCharacter, useChatPages, usePersonas } from '../../api/queries'
import { EyeIcon, MenuIcon, PanelIcon, SettingsIcon } from '../../components/icons'
import { IconButton } from '../../components/ui'
import { emitClientEvent } from '../../extensions/runtime'
import { Slot } from '../../extensions/Slot'
import { useAppearance } from '../../stores/appearance'
import { useStreaming } from '../../stores/streaming'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { Composer } from './Composer'
import { runGeneration } from './generate'
import type { ChatCast } from './MessageItem'
import { MessageList } from './MessageList'

export function ChatView({ chatId }: { chatId: string }) {
  useEffect(() => {
    emitClientEvent({ type: 'chat:open', chatId })
  }, [chatId])
  const qc = useQueryClient()
  const pages = useChatPages(chatId)
  const firstPage = pages.data?.pages[0]
  const chat = firstPage?.chat
  const group = firstPage?.group ?? null
  const character = useCharacter(chat?.characterId ?? null)
  const personas = usePersonas()
  const messages = useMemo(() => flattenPages(pages.data), [pages.data])
  const streamingHere = useStreaming((s) => s.chatId === chatId)
  const { setSidebarOpen, setPreviewOpen, previewOpen, chatSettingsOpen, setChatSettingsOpen } = useUi()
  const sidebarCollapsed = useAppearance((s) => s.sidebarCollapsed)
  const setAppearance = useAppearance((s) => s.set)

  // 会话里出场的人：群聊是全部成员，单人会话是那个角色；用户是会话绑定的人设（没有就用默认人设）
  const persona = personas.data?.find((p) => p.id === chat?.personaId) ?? personas.data?.find((p) => p.isDefault)
  const cast = useMemo<ChatCast>(() => {
    const speakers: ChatCast['speakers'] = {}
    if (group) for (const m of group.members) speakers[m.characterId] = { name: m.name, avatarUrl: m.avatarUrl }
    if (character.data) speakers[character.data.id] = { name: character.data.name, avatarUrl: character.data.avatarUrl }
    return {
      speakers,
      fallback: { name: character.data?.name ?? group?.name ?? '角色', avatarUrl: character.data?.avatarUrl ?? null },
      user: { name: persona?.name ?? '我', avatarUrl: persona?.avatarUrl ?? null },
    }
  }, [group, character.data, persona])

  // 打开会话时后端还在生成（比如刚刷新了页面）：重新接上这次生成
  const backendGenerating = firstPage?.generating ?? false
  useEffect(() => {
    if (backendGenerating && useStreaming.getState().chatId !== chatId) {
      runGeneration(qc, chatId, 'reconnect').catch((e) => toast.error(errorMessage(e)))
    }
  }, [backendGenerating, chatId, qc])

  const busy = streamingHere || backendGenerating

  // 记住的会话已经不存在了（被删除、换了数据目录）：回到欢迎页
  const notFound = pages.error instanceof ApiRequestError && pages.error.status === 404
  useEffect(() => {
    if (notFound) useUi.getState().openChat({}, null)
  }, [notFound])

  if (pages.isError) {
    return <div className="p-8 text-center text-sm text-zinc-500">会话加载失败：{errorMessage(pages.error)}</div>
  }

  const subtitle = group ? group.members.map((m) => m.name).join('、') : chat?.title

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
        <IconButton label="打开侧栏" className="md:hidden" onClick={() => setSidebarOpen(true)}>
          <MenuIcon />
        </IconButton>
        {/* 宽屏：收起 / 展开侧栏 */}
        <IconButton
          label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
          className="max-md:hidden"
          onClick={() => setAppearance({ sidebarCollapsed: !sidebarCollapsed })}
        >
          <PanelIcon />
        </IconButton>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{group?.name ?? character.data?.name ?? '…'}</div>
          <div className="truncate text-xs text-zinc-500">{subtitle}</div>
        </div>
        <Slot name="chat.header.actions" props={{ chatId }} />
        <IconButton
          label="会话设置"
          onClick={() => {
            setChatSettingsOpen(!chatSettingsOpen)
            setPreviewOpen(false)
            if (!chatSettingsOpen) setSidebarOpen(true)
          }}
        >
          <SettingsIcon />
        </IconButton>
        <IconButton
          label="Prompt 预览"
          onClick={() => {
            setPreviewOpen(!previewOpen)
            setChatSettingsOpen(false)
            if (!previewOpen) setSidebarOpen(true)
          }}
        >
          <EyeIcon />
        </IconButton>
      </header>

      {pages.isPending ? (
        <div className="flex-1 p-8 text-center text-sm text-zinc-400">加载中…</div>
      ) : (
        <MessageList
          chatId={chatId}
          messages={messages}
          busy={busy}
          hasMore={pages.hasNextPage}
          loadingMore={pages.isFetchingNextPage}
          loadMore={() => void pages.fetchNextPage()}
          cast={cast}
        />
      )}
      <Composer chatId={chatId} generating={busy} group={group} lastMessage={messages.at(-1) ?? null} />
    </div>
  )
}
