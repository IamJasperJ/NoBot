import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useRef } from 'react'
import { useCharacters, useConnections } from './api/queries'
import {
  BookIcon,
  ChatIcon,
  LogIcon,
  MenuIcon,
  PlugIcon,
  PuzzleIcon,
  SlidersIcon,
  UserIcon,
  UsersIcon,
} from './components/icons'
import { Button, cx, IconButton } from './components/ui'
import { loadExtensions, useExtensionsRuntime } from './extensions/runtime'
import { ExtensionPage } from './extensions/Slot'
import { CharactersPage } from './features/characters/CharactersPage'
import { Sidebar } from './features/characters/Sidebar'
import { ChatView } from './features/chat/ChatView'
import { PromptPreview } from './features/chat/PromptPreview'
import { ConnectionsPage } from './features/connections/ConnectionsPage'
import { ExtensionsPage } from './features/extensions/ExtensionsPage'
import { LogsPage } from './features/logs/LogsPage'
import { LorebooksPage } from './features/lorebooks/LorebooksPage'
import { PersonasPage } from './features/personas/PersonasPage'
import { PresetsPage } from './features/presets/PresetsPage'
import { useToasts } from './stores/toast'
import { useUi, type View } from './stores/ui'

const NAV: { view: View; label: string; icon: ReactNode }[] = [
  { view: 'chat', label: '聊天', icon: <ChatIcon /> },
  { view: 'characters', label: '角色', icon: <UsersIcon /> },
  { view: 'lorebooks', label: '世界书', icon: <BookIcon /> },
  { view: 'presets', label: '生成预设', icon: <SlidersIcon /> },
  { view: 'connections', label: '连接', icon: <PlugIcon /> },
  { view: 'personas', label: '人设', icon: <UserIcon /> },
  { view: 'extensions', label: '扩展', icon: <PuzzleIcon /> },
  { view: 'logs', label: '日志', icon: <LogIcon /> },
]

/** 最左侧的图标导航 */
function NavRail() {
  const { view, openView } = useUi()
  const pages = useExtensionsRuntime((s) => s.pages)
  return (
    <nav className="flex w-16 shrink-0 flex-col items-center gap-1 border-r border-zinc-200 bg-zinc-50 py-3 dark:border-zinc-800 dark:bg-zinc-900">
      {[
        ...NAV,
        ...pages.map((p) => ({ view: `ext:${p.extensionId}:${p.id}` as View, label: p.label, icon: p.icon })),
      ].map((n) => (
        <button
          key={n.view}
          type="button"
          onClick={() => openView(n.view)}
          className={cx(
            'flex w-14 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[11px]',
            view === n.view
              ? 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300'
              : 'text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800',
          )}
        >
          {n.icon}
          {n.label}
        </button>
      ))}
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
      <header className="flex h-14 items-center px-3 md:hidden">
        <IconButton label="打开侧栏" onClick={() => setSidebarOpen(true)}>
          <MenuIcon />
        </IconButton>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
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

function Page({ view }: { view: View }) {
  if (String(view).startsWith('ext:')) return <ExtensionPage view={view} />
  switch (view) {
    case 'characters':
      return <CharactersPage />
    case 'lorebooks':
      return <LorebooksPage />
    case 'presets':
      return <PresetsPage />
    case 'connections':
      return <ConnectionsPage />
    case 'personas':
      return <PersonasPage />
    case 'extensions':
      return <ExtensionsPage />
    case 'logs':
      return <LogsPage />
    default:
      return null
  }
}

export function App() {
  const qc = useQueryClient()
  useEffect(() => {
    void loadExtensions(qc)
  }, [qc])
  const { view, chatId, previewOpen, sidebarOpen, setSidebarOpen } = useUi()
  const isChat = view === 'chat'

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* 桌面端：导航和聊天侧栏常驻；手机端：收进抽屉，点左上角菜单打开 */}
      {sidebarOpen && (
        <button
          type="button"
          aria-label="关闭侧栏"
          className="fixed inset-0 z-20 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <div
        className={cx(
          'z-30 flex h-full max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:transition-transform',
          !sidebarOpen && 'max-md:-translate-x-full',
        )}
      >
        <NavRail />
        {isChat && <Sidebar />}
      </div>

      <main className="flex min-w-0 flex-1">
        {isChat ? (
          <>
            {chatId ? <ChatView key={chatId} chatId={chatId} /> : <Welcome />}
            {chatId && previewOpen && <PromptPreview chatId={chatId} />}
          </>
        ) : (
          <Page view={view} />
        )}
      </main>
      <Toasts />
    </div>
  )
}
