import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { flattenPages, useCharacter, useChatPages, usePersonas } from '../../api/queries'
import { EyeIcon, MenuIcon } from '../../components/icons'
import { IconButton } from '../../components/ui'
import { useStreaming } from '../../stores/streaming'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { Composer } from './Composer'
import { runGeneration } from './generate'
import { MessageList } from './MessageList'

export function ChatView({ chatId }: { chatId: string }) {
  const qc = useQueryClient()
  const pages = useChatPages(chatId)
  const firstPage = pages.data?.pages[0]
  const character = useCharacter(firstPage?.chat.characterId ?? null)
  const personas = usePersonas()
  const messages = useMemo(() => flattenPages(pages.data), [pages.data])
  const streamingHere = useStreaming((s) => s.chatId === chatId)
  const { setSidebarOpen, setPreviewOpen, previewOpen } = useUi()

  const userName =
    personas.data?.find((p) => p.id === firstPage?.chat.personaId)?.name ??
    personas.data?.find((p) => p.isDefault)?.name ??
    '我'

  // 打开会话时后端还在生成（比如刚刷新了页面）：重新接上这次生成
  const backendGenerating = firstPage?.generating ?? false
  useEffect(() => {
    if (backendGenerating && useStreaming.getState().chatId !== chatId) {
      runGeneration(qc, chatId, 'reconnect').catch((e) => toast.error(errorMessage(e)))
    }
  }, [backendGenerating, chatId, qc])

  const busy = streamingHere || backendGenerating

  if (pages.isError) {
    return <div className="p-8 text-center text-sm text-zinc-500">会话加载失败：{errorMessage(pages.error)}</div>
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
        <IconButton label="打开侧栏" className="md:hidden" onClick={() => setSidebarOpen(true)}>
          <MenuIcon />
        </IconButton>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{character.data?.name ?? '…'}</div>
          <div className="truncate text-xs text-zinc-500">{firstPage?.chat.title}</div>
        </div>
        <IconButton label="Prompt 预览" onClick={() => setPreviewOpen(!previewOpen)}>
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
          charName={character.data?.name ?? ''}
          charAvatar={character.data?.avatarUrl ?? null}
          userName={userName}
        />
      )}
      <Composer chatId={chatId} generating={busy} />
    </div>
  )
}
