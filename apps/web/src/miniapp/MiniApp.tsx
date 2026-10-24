import type { ChatPage } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { readError } from '../api/client'
import { flattenPages, keys, useCharacter, useChatPages } from '../api/queries'
import { queryClient } from '../api/queryClient'
import { setRoomScope } from '../api/room-scope'
import { roomKeys } from '../api/rooms'
import { Background } from '../components/Background'
import type { ChatCast } from '../features/chat/MessageItem'
import { VnView } from '../features/vn/VnView'
import { t } from '../i18n'
import { useStreaming } from '../stores/streaming'
import { errorMessage, useToasts } from '../stores/toast'
import { useVn } from '../stores/vn'
import { type MiniAppContext, useMiniAppContext } from './context'
import { loadTelegram } from './telegram'

// StrictMode 的双挂载共享同一兑换请求，避免自己触发 initData 防重放。
let boot: Promise<void> | undefined
async function bootstrap() {
  const telegram = await loadTelegram()
  telegram.ready()
  telegram.expand()
  const query = new URLSearchParams(location.search)
  const signed = new URLSearchParams(telegram.initData)
  const start = signed.get('start_param') ?? query.get('a')
  const handle = query.get('h')
  if (!telegram.initData || !start || !handle) throw new Error(t('请从 Telegram 中打开舞台链接'))
  // 重载已有作用域时复用 HttpOnly 会话；服务端核对启动令牌仍指向同一绑定。
  const contextUrl = `/api/miniapp/context?start=${encodeURIComponent(start)}`
  let contextResponse = await fetch(contextUrl, { credentials: 'include' })
  if (!contextResponse.ok) {
    const response = await fetch(`/hooks/channels/${encodeURIComponent(handle)}/miniapp/session`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: telegram.initData, start }),
    })
    if (!response.ok) throw await readError(response)
    contextResponse = await fetch(contextUrl, { credentials: 'include' })
  }
  if (!contextResponse.ok) throw await readError(contextResponse)
  const context = (await contextResponse.json()) as MiniAppContext
  queryClient.clear()
  queryClient.setQueryData(roomKeys.list, context.room ? [context.room] : [])
  if (context.room) {
    setRoomScope(context.room)
    queryClient.setQueryData(roomKeys.detail(context.room.id), context.room)
  }
  if (context.backgrounds) queryClient.setQueryData(keys.backgrounds, context.backgrounds)
  if (context.preset) queryClient.setQueryData(keys.playPresets, [context.preset])
  if (context.character) queryClient.setQueryData(keys.character(context.character.id), context.character)
  if (!context.chatId) throw new Error(t('VN 舞台暂不可用'))
  useVn.getState().setMode(context.chatId, 'vn')
  useMiniAppContext.setState({ ...context, status: 'ready', error: null })
}
export function MiniApp() {
  const context = useMiniAppContext()
  useEffect(() => {
    if (!boot)
      boot = bootstrap().catch((e: unknown) => useMiniAppContext.setState({ status: 'error', error: errorMessage(e) }))
    let active = true
    let cleanup: (() => void) | undefined
    void loadTelegram()
      .then((telegram) => {
        if (!active) return
        const theme = () => {
          for (const [key, value] of Object.entries(telegram.themeParams))
            document.documentElement.style.setProperty(`--tg-${key.replaceAll('_', '-')}`, value)
        }
        const close = () => telegram.close()
        theme()
        telegram.onEvent('themeChanged', theme)
        telegram.BackButton.show()
        telegram.BackButton.onClick(close)
        cleanup = () => {
          telegram.offEvent('themeChanged', theme)
          telegram.BackButton.offClick(close)
        }
      })
      .catch(() => {})
    return () => {
      active = false
      cleanup?.()
    }
  }, [])
  if (context.status === 'error') return <MiniAppError message={context.error ?? t('VN 舞台暂不可用')} />
  if (context.status !== 'ready' || !context.chatId) return <MiniAppLoading />
  return (
    <>
      <MiniAppMessages />
      <Stage chatId={context.chatId} />
    </>
  )
}
function Stage({ chatId }: { chatId: string }) {
  const context = useMiniAppContext()
  const qc = useQueryClient()
  const pages = useChatPages(chatId)
  const page: ChatPage | undefined = pages.data?.pages[0]
  const messages = useMemo(() => flattenPages(pages.data), [pages.data])
  const character = useCharacter(page?.chat.characterId ?? null).data ?? context.character
  const streaming = useStreaming((state) => !!state.streams[chatId])
  useEffect(() => {
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: keys.chat(chatId) })
    }
    const events = new EventSource('/api/miniapp/events', { withCredentials: true })
    events.addEventListener('change', refresh)
    // 后台生图和 DM 生成不都走 liveHub，保留轻量轮询。
    const timer = setInterval(refresh, 3000)
    return () => {
      events.close()
      clearInterval(timer)
    }
  }, [chatId, qc])
  const speakers: ChatCast['speakers'] = {}
  if (page?.group)
    for (const member of page.group.members)
      speakers[member.characterId] = { name: member.name, avatarUrl: member.avatarUrl }
  if (character) speakers[character.id] = { name: character.name, avatarUrl: character.avatarUrl }
  const cast: ChatCast = {
    speakers,
    fallback: { name: character?.name ?? t('角色'), avatarUrl: character?.avatarUrl ?? null },
    user: {
      name: context.room?.myUserId
        ? (context.room.members.find((m) => m.userId === context.room?.myUserId)?.personaName ?? t('我'))
        : t('我'),
      avatarUrl: null,
    },
    stage: null,
  }
  const play = page?.roomView?.play ?? context.preset?.data
  if (pages.error) return <MiniAppError message={errorMessage(pages.error)} />
  if (!page || !play) return <MiniAppLoading />
  return (
    <main className="relative flex h-dvh overflow-hidden bg-black">
      <Background chatId={chatId} />
      <VnView
        chatId={chatId}
        messages={messages}
        play={play}
        cast={cast}
        group={page.group}
        busy={streaming || page.generating}
        liveVars={page.vars}
        stateSchema={page.stateSchema}
      />
    </main>
  )
}

/** Telegram 主题色优先，没有时退回 NoBot 自己的深色 */
const shell =
  'flex h-dvh flex-col items-center justify-center gap-4 px-6 text-center bg-[var(--tg-bg-color,#18181b)] text-[var(--tg-text-color,#f4f4f5)]'

function MiniAppLoading() {
  return (
    <div className={shell}>
      <span className="size-8 animate-spin rounded-full border-2 border-current border-t-transparent opacity-60" />
      <p className="text-sm opacity-70">{t('正在打开舞台…')}</p>
    </div>
  )
}

function MiniAppError({ message }: { message: string }) {
  return (
    <div role="alert" className={shell}>
      <p className="max-w-xs text-[15px] leading-relaxed">{message}</p>
      <a
        href="/"
        target="_blank"
        rel="noreferrer"
        className="rounded-lg bg-[var(--tg-button-color,#7c3aed)] px-4 py-2 text-sm font-medium text-[var(--tg-button-text-color,#fff)]"
      >
        {t('在浏览器中打开')}
      </a>
    </div>
  )
}
/** 舞台上方的轻提示：发送失败、权限不足等，几秒后由 toast store 自己移除 */
function MiniAppMessages() {
  const toasts = useToasts((state) => state.toasts)
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-50 flex flex-col items-center gap-1.5 px-3">
      {toasts.map((item) => (
        <div
          key={item.id}
          role="status"
          className="max-w-sm rounded-lg bg-black/75 px-3 py-2 text-[13px] text-white shadow-lg backdrop-blur"
        >
          {item.message}
        </div>
      ))}
    </div>
  )
}
