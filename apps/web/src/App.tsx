import { useQueryClient } from '@tanstack/react-query'
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import { useCharacters, useConnections } from './api/queries'
import { Background } from './components/Background'
import {
  BookIcon,
  ChatIcon,
  ImageIcon,
  LogIcon,
  MenuIcon,
  PlugIcon,
  PuzzleIcon,
  SettingsIcon,
  SlidersIcon,
  UserIcon,
  UsersIcon,
} from './components/icons'
import { Button, cx, IconButton } from './components/ui'
import { loadExtensions } from './extensions/runtime'
import { BackgroundsPage } from './features/backgrounds/BackgroundsPage'
import { CharactersPage } from './features/characters/CharactersPage'
import { ChatPanelContent, ResizeHandle } from './features/chat/ChatPanelContent'
import { ChatView } from './features/chat/ChatView'
import { ConnectionsPage } from './features/connections/ConnectionsPage'
import { ExtensionsPage } from './features/extensions/ExtensionsPage'
import { LogsPage } from './features/logs/LogsPage'
import { LorebooksPage } from './features/lorebooks/LorebooksPage'
import { PersonasPage } from './features/personas/PersonasPage'
import { PresetsPage } from './features/presets/PresetsPage'
import { SettingsPage } from './features/settings/SettingsPage'
import { useMobile } from './hooks/useMobile'
import { useQuickReplyAutomation } from './hooks/useQuickReplyAutomation'
import { t } from './i18n'
import { useAppearance } from './stores/appearance'
import { useSessionStore } from './stores/session'
import { useToasts } from './stores/toast'
import { useUi, type View } from './stores/ui'

const NAV = (): { view: View; label: string; icon: ReactNode }[] => [
  { view: 'chat', label: t('聊天'), icon: <ChatIcon /> },
  { view: 'characters', label: t('角色'), icon: <UsersIcon /> },
  { view: 'lorebooks', label: t('世界书'), icon: <BookIcon /> },
  { view: 'presets', label: t('生成预设'), icon: <SlidersIcon /> },
  { view: 'connections', label: t('连接'), icon: <PlugIcon /> },
  { view: 'personas', label: t('人设'), icon: <UserIcon /> },
  { view: 'backgrounds', label: t('背景'), icon: <ImageIcon /> },
  { view: 'extensions', label: t('扩展'), icon: <PuzzleIcon /> },
  { view: 'logs', label: t('日志'), icon: <LogIcon /> },
]

/** 最左侧的图标导航。项目多时可以滚动；「设置」固定在最下面 */
function NavRail({
  hidden = false,
  floating = false,
  onHover,
  onLeave,
}: {
  hidden?: boolean
  floating?: boolean
  onHover?: () => void
  onLeave?: () => void
}) {
  const { view, panelOpen, toggleView } = useUi()
  const item = (n: { view: View; label: string; icon: ReactNode }) => (
    <button
      key={n.view}
      type="button"
      onClick={() => toggleView(n.view)}
      aria-pressed={panelOpen && view === n.view}
      className={cx(
        'flex w-14 shrink-0 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[11px]',
        panelOpen && view === n.view
          ? 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300'
          : 'text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800',
      )}
    >
      {n.icon}
      <span className="max-w-full truncate px-0.5">{n.label}</span>
    </button>
  )
  return (
    <nav
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      className={cx(
        'nav-rail flex w-16 shrink-0 flex-col items-center border-r border-zinc-200 bg-zinc-50 py-3 dark:border-zinc-800 dark:bg-zinc-900',
        // 宽屏：固定在左侧，自动隐藏时移出屏幕，悬停时滑回来盖在内容上（不推动聊天区）
        'md:fixed md:inset-y-0 md:left-0 md:z-30 md:transition-transform md:duration-200',
        hidden && 'md:-translate-x-full',
        floating && 'md:shadow-xl',
      )}
    >
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto">{NAV().map(item)}</div>
      <div className="mt-1 border-t border-zinc-200 pt-1 dark:border-zinc-800">
        {item({ view: 'settings', label: t('设置'), icon: <SettingsIcon /> })}
      </div>
    </nav>
  )
}

/** 没打开会话时的引导页：按顺序提示该做什么 */
function Welcome() {
  const connections = useConnections()
  const characters = useCharacters()
  const { openView, setSidebarOpen } = useUi()

  let tip = t('在左侧选一个角色或群聊，然后新建会话')
  let action: { label: string; run: () => void } | null = null
  if (connections.data?.length === 0) {
    tip = t('第一步：添加一个模型连接（OpenAI 兼容，比如 DeepSeek、OpenRouter）')
    action = { label: t('去添加连接'), run: () => openView('connections') }
  } else if (characters.data?.length === 0) {
    tip = t('第二步：导入一张酒馆角色卡（PNG 或 JSON），或者新建一个角色')
    action = { label: t('去角色页'), run: () => openView('characters') }
  }

  return (
    <div className="flex h-full flex-1 flex-col">
      <header
        className="flex h-14 shrink-0 items-center pr-3 md:hidden"
        style={{ paddingLeft: 'calc(var(--panel-offset) + 0.75rem)' }}
      >
        <IconButton label={t('打开侧栏')} onClick={() => setSidebarOpen(true)}>
          <MenuIcon />
        </IconButton>
      </header>
      <div className="chat-column flex flex-1 flex-col items-center justify-center gap-4 py-8 text-center">
        <div className="welcome-card flex flex-col items-center gap-4">
          <div className="text-2xl font-semibold tracking-tight">NoBot</div>
          <p className="max-w-sm text-sm text-zinc-500">{tip}</p>
          {action && (
            <Button variant="primary" onClick={action.run}>
              {action.label}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 提示条。用 popover 放进浏览器的「顶层」：对话框也在顶层，
 * 普通的 z-index 压不过它，每次有新提示时重新打开 popover，让提示条排到最上面。
 */
function Toasts() {
  const { toasts, dismiss } = useToasts()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (el.matches(':popover-open')) el.hidePopover()
    if (toasts.length > 0) el.showPopover()
  }, [toasts])

  return (
    <div
      ref={ref}
      popover="manual"
      className="pointer-events-none inset-x-0 top-4 bottom-auto m-0 w-full overflow-visible border-0 bg-transparent p-0"
    >
      <div className="flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => dismiss(t.id)}
            className={cx(
              'pointer-events-auto max-w-lg rounded-xl px-4 py-2.5 text-left text-sm whitespace-pre-wrap shadow-lg',
              t.kind === 'error'
                ? 'bg-red-600 text-white'
                : 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900',
            )}
          >
            {t.message}
          </button>
        ))}
      </div>
    </div>
  )
}

function PanelContent({ view }: { view: View }) {
  switch (view) {
    case 'chat':
      return <ChatPanelContent />
    case 'characters':
      return <CharactersPage />
    case 'lorebooks':
      return <LorebooksPage />
    case 'presets':
      return <PresetsPage />
    case 'connections':
      return <ConnectionsPage />
    case 'backgrounds':
      return <BackgroundsPage />
    case 'personas':
      return <PersonasPage />
    case 'extensions':
      return <ExtensionsPage />
    case 'logs':
      return <LogsPage />
    case 'settings':
      return <SettingsPage />
    default:
      return null
  }
}

export function App() {
  useQuickReplyAutomation()
  const qc = useQueryClient()
  const sessionStatus = useSessionStore((s) => s.status)
  useEffect(() => {
    if (sessionStatus === 'authenticated') void loadExtensions(qc)
  }, [qc, sessionStatus])
  const { view, chatId, panelOpen, sidebarOpen, setSidebarOpen } = useUi()
  const mobile = useMobile()
  // 导航栏自动隐藏：打开侧边面板时固定显示（面板贴着它），否则鼠标移到左边缘才滑出
  const autoHideNav = useAppearance((s) => s.autoHideNav)
  const navPinned = !autoHideNav || panelOpen
  const [navHover, setNavHover] = useState(false)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const revealNav = () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    setNavHover(true)
  }
  const hideNav = () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    leaveTimer.current = setTimeout(() => setNavHover(false), 250)
  }

  return (
    <div
      className="app-root relative isolate flex h-dvh overflow-hidden"
      style={
        {
          '--panel-offset': panelOpen ? 'var(--sidebar-width)' : '0px',
          // 导航栏占的宽度：固定显示时 4rem，自动隐藏时 0（悬停滑出时盖在内容上，不占位置）
          '--nav-width': navPinned ? '4rem' : '0px',
        } as CSSProperties
      }
    >
      {/* 背景铺满整个窗口（导航栏下面也有），在所有内容下面 */}
      <Background chatId={chatId} />
      {sidebarOpen && (
        <button
          type="button"
          aria-label={t('关闭侧栏')}
          className="fixed inset-0 z-20 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <div
        inert={mobile && !sidebarOpen}
        className={cx(
          'fixed inset-y-0 left-0 z-30 flex h-full transition-transform md:contents',
          !sidebarOpen && 'max-md:-translate-x-full',
        )}
      >
        <NavRail
          hidden={!mobile && !navPinned && !navHover}
          floating={!navPinned && navHover}
          onHover={revealNav}
          onLeave={hideNav}
        />
        {/* 抽屉隐藏时卸载面板，手机上的详情传送门也随之关闭。 */}
        {panelOpen && (!mobile || sidebarOpen) && (
          <aside className="side-panel relative h-full w-[min(var(--sidebar-width),calc(100vw-4rem))] min-w-0 shrink-0 border-r border-zinc-200 bg-white md:fixed md:inset-y-0 md:left-[var(--nav-width)] md:z-20 md:w-[var(--sidebar-width)] dark:border-zinc-800 dark:bg-zinc-950">
            <PanelContent view={view} />
            <ResizeHandle />
          </aside>
        )}
      </div>
      {/* 宽屏：导航栏固定显示时在文档流里给它留出位置；自动隐藏时左边缘留一条感应区，鼠标移过来就滑出 */}
      <div aria-hidden="true" className="hidden shrink-0 md:block" style={{ width: 'var(--nav-width)' }} />
      {!mobile && !navPinned && (
        <div aria-hidden="true" className="fixed inset-y-0 left-0 z-30 w-2" onMouseEnter={revealNav} />
      )}
      <main className="relative min-w-0 flex-1">
        {chatId ? <ChatView key={chatId} chatId={chatId} /> : <Welcome />}
      </main>
      <div
        id="overlay-root"
        className="fixed inset-0 z-40 bg-white md:left-[calc(var(--nav-width)+var(--panel-offset))] md:z-30 md:border-l md:border-zinc-200 dark:bg-zinc-950 dark:md:border-zinc-800"
      />
      <Toasts />
    </div>
  )
}
