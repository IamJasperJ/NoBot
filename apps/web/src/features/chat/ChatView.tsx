import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef } from 'react'
import { ApiRequestError } from '../../api/client'
import { flattenPages, keys, useCharacter, useChatPages, usePersonas, usePlayPresets } from '../../api/queries'
import { MenuIcon } from '../../components/icons'
import { IconButton } from '../../components/ui'
import { emitClientEvent } from '../../extensions/runtime'
import { t } from '../../i18n'
import { useChatOps } from '../../stores/chatOps'
import { useStreaming } from '../../stores/streaming'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { useVnMode } from '../../stores/vn'
import { VnView } from '../vn/VnView'
import { Composer } from './Composer'
import { runGeneration } from './generate'
import type { ChatCast } from './MessageItem'
import { MessageList } from './MessageList'
import { SelectionBar } from './SelectionBar'
import { SideSprite } from './SideSprite'

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
  const playPresets = usePlayPresets()
  const messages = useMemo(() => flattenPages(pages.data), [pages.data])
  // 图片生成、兜底情绪判断都是后台异步完成的，进行中时轮询刷新
  const pendingImage = messages.some(
    (message) => message.meta.imageGen?.status === 'pending' || message.meta.stage?.classify === 'pending',
  )
  useEffect(() => {
    if (!pendingImage) return
    const timer = setInterval(() => {
      void qc.invalidateQueries({ queryKey: keys.chat(chatId) })
    }, 2000)
    return () => clearInterval(timer)
  }, [pendingImage, chatId, qc])
  const streamingHere = useStreaming((s) => s.chatId === chatId)
  const setSidebarOpen = useUi((s) => s.setSidebarOpen)
  const root = useRef<HTMLDivElement>(null)

  // 会话里出场的人：群聊是全部成员，单人会话是那个角色；用户是会话绑定的人设（没有就用默认人设）
  const persona = personas.data?.find((p) => p.id === chat?.personaId) ?? personas.data?.find((p) => p.isDefault)
  const play = playPresets.data?.find((p) => p.id === firstPage?.playPresetId)?.data
  const stageCast = firstPage?.stage?.cast
  const cast = useMemo<ChatCast>(() => {
    const speakers: ChatCast['speakers'] = {}
    if (group) for (const m of group.members) speakers[m.characterId] = { name: m.name, avatarUrl: m.avatarUrl }
    if (character.data) speakers[character.data.id] = { name: character.data.name, avatarUrl: character.data.avatarUrl }
    return {
      speakers,
      fallback: {
        name: character.data?.name ?? group?.name ?? t('角色'),
        avatarUrl: character.data?.avatarUrl ?? null,
      },
      user: { name: persona?.name ?? t('我'), avatarUrl: persona?.avatarUrl ?? null },
      // 玩法预设开了舞台指令：消息里的指令要藏起来、台词按速记改写、显示选项
      stage: play?.directives.enabled
        ? {
            knownNames: [...Object.values(speakers).map((s) => s.name), ...(stageCast ?? []).map((m) => m.name)],
            narratorNames: play.trpg.gmName ? [play.trpg.gmName] : [],
            showSpeaker: play.directives.showSpeaker,
            choices: play.interaction.choices,
          }
        : null,
    }
  }, [group, character.data, persona, play, stageCast])

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

  // VN 视图：玩法预设开了指令才可用；会话自己选过就按选的，否则按预设的「默认以 VN 视图打开」
  const vnWanted = useVnMode(chatId, !!play?.basic.openInVn)
  const selectingChat = useChatOps((s) => s.selectingChat)
  // 换会话时退出多选
  useEffect(() => () => useChatOps.getState().stopSelect(), [chatId])
  if (pages.isError) {
    return (
      <div className="p-8 text-center text-sm text-zinc-500">
        {t('会话加载失败：{error}', { error: errorMessage(pages.error) })}
      </div>
    )
  }

  const lastReply = messages.findLast((m) => m.role === 'assistant') ?? null
  const selecting = selectingChat === chatId
  const vn = !!play?.directives.enabled && vnWanted && !pages.isPending

  return (
    <div ref={root} className="relative isolate flex h-full min-w-0 flex-1 flex-col">
      {!vn && firstPage?.stage && play && (
        <SideSprite stage={firstPage.stage} play={play} cast={cast} lastReply={lastReply} container={root} />
      )}
      {/* 不再有顶部标题栏：会话设置、Prompt 预览在输入框左边的「+」菜单里。手机上保留一个打开抽屉的悬浮按钮 */}
      <IconButton
        label={t('打开侧栏')}
        className="chat-float-button fixed top-3 left-3 z-20 size-9 rounded-full border border-zinc-200 bg-white/90 shadow-sm backdrop-blur md:hidden dark:border-zinc-700 dark:bg-zinc-900/90"
        onClick={() => setSidebarOpen(true)}
      >
        <MenuIcon />
      </IconButton>

      {vn && play ? (
        <VnView
          chatId={chatId}
          messages={messages}
          play={play}
          cast={cast}
          group={group}
          busy={busy}
          liveVars={firstPage?.vars ?? {}}
          stateSchema={firstPage?.stateSchema ?? {}}
        />
      ) : (
        <>
          {pages.isPending ? (
            <div className="flex-1 p-8 text-center text-sm text-zinc-400">{t('加载中…')}</div>
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
          {selecting ? (
            <SelectionBar chatId={chatId} messages={messages} />
          ) : (
            <Composer chatId={chatId} generating={busy} group={group} lastMessage={messages.at(-1) ?? null} />
          )}
        </>
      )}
    </div>
  )
}
