import { useQueryClient } from '@tanstack/react-query'
import { type CSSProperties, type ReactNode, useEffect, useRef } from 'react'
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
import { useToasts } from './stores/toast'
import { useUi, type View } from './stores/ui'

const NAV: { view: View; label: string; icon: ReactNode }[] = [
  { view: 'chat', label: '聊天', icon: <ChatIcon /> },
  { view: 'characters', label: '角色', icon: <UsersIcon /> },
  { view: 'lorebooks', label: '世界书', icon: <BookIcon /> },
  { view: 'presets', label: '生成预设', icon: <SlidersIcon /> },
  { view: 'connections', label: '连接', icon: <PlugIcon /> },
  { view: 'personas', label: '人设', icon: <UserIcon /> },
  { view: 'backgrounds', label: '背景', icon: <ImageIcon /> },
  { view: 'extensions', label: '扩展', icon: <PuzzleIcon /> },
  { view: 'logs', label: '日志', icon: <LogIcon /> },
]

/** 最左侧的图标导航。项目多时可以滚动；「设置」固定在最下面 */
function NavRail() {
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
    <nav className="flex w-16 shrink-0 flex-col items-center border-r border-zinc-200 bg-zinc-50 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto">{NAV.map(item)}</div>
      <div className="mt-1 border-t border-zinc-200 pt-1 dark:border-zinc-800">
        {item({ view: 'settings', label: '设置', icon: <SettingsIcon /> })}
      </div>
    </nav>
  )
}

/** 没打开会话时的引导页：按顺序提示该做什么 */
function Welcome() {
  const connections = useConnections()
  const characters = useCharacters()
  const { openView, setSidebarOpen } = useUi()

  let tip = '在左侧选一个角色或群聊，然后新建会话'
  let action: { label: string; run: () => void } | null = null
  if (connections.data?.length === 0) {
    tip = '第一步：添加一个模型连接（OpenAI 兼容，比如 DeepSeek、OpenRouter）'
    action = { label: '去添加连接', run: () => openView('connections') }
  } else if (characters.data?.length === 0) {
    tip = '第二步：导入一张酒馆角色卡（PNG 或 JSON），或者新建一个角色'
    action = { label: '去角色页', run: () => openView('characters') }
  }

  return (
    <div className="flex h-full flex-1 flex-col">
      <header
        className="flex h-14 shrink-0 items-center pr-3 md:hidden"
        style={{ paddingLeft: 'calc(var(--panel-offset) + 0.75rem)' }}
      >
        <IconButton label="打开侧栏" onClick={() => setSidebarOpen(true)}>
          <MenuIcon />
        </IconButton>
      </header>
      <div className="chat-column flex flex-1 flex-col items-center justify-center gap-4 py-8 text-center">
        <div className="text-2xl font-semibold tracking-tight">AI-Parter</div>
        <p className="max-w-sm text-sm text-zinc-500">{tip}</p>
        {action && (
          <Button variant="primary" onClick={action.run}>
            {action.label}
          </Button>
        )}
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
  const qc = useQueryClient()
  useEffect(() => {
    void loadExtensions(qc)
  }, [qc])
  const { view, chatId, panelOpen, sidebarOpen, setSidebarOpen } = useUi()
  const mobile = useMobile()

  return (
    <div
      className="app-root flex h-dvh overflow-hidden"
      style={{ '--panel-offset': panelOpen ? 'var(--sidebar-width)' : '0px' } as CSSProperties}
    >
      {sidebarOpen && (
        <button
          type="button"
          aria-label="关闭侧栏"
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
        <NavRail />
        {/* 抽屉隐藏时卸载面板，手机上的详情传送门也随之关闭。 */}
        {panelOpen && (!mobile || sidebarOpen) && (
          <aside className="relative h-full w-[min(var(--sidebar-width),calc(100vw-4rem))] min-w-0 shrink-0 border-r border-zinc-200 bg-white md:fixed md:inset-y-0 md:left-16 md:z-20 md:w-[var(--sidebar-width)] dark:border-zinc-800 dark:bg-zinc-950">
            <PanelContent view={view} />
            <ResizeHandle />
          </aside>
        )}
      </div>
      <main className="relative isolate min-w-0 flex-1">
        <Background chatId={chatId} />
        {chatId ? <ChatView key={chatId} chatId={chatId} /> : <Welcome />}
      </main>
      <div
        id="overlay-root"
        className="fixed inset-0 z-40 bg-white md:left-[calc(4rem+var(--panel-offset))] md:z-30 md:border-l md:border-zinc-200 dark:bg-zinc-950 dark:md:border-zinc-800"
      />
      <Toasts />
    </div>
  )
}
