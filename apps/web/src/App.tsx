import { useEffect, useRef } from 'react'
import { useApiPresets, useCharacters } from './api/queries'
import { MenuIcon } from './components/icons'
import { Button, cx, IconButton } from './components/ui'
import { Sidebar } from './features/characters/Sidebar'
import { ChatView } from './features/chat/ChatView'
import { PromptPreview } from './features/chat/PromptPreview'
import { SettingsDialog } from './features/presets/SettingsDialog'
import { useToasts } from './stores/toast'
import { useUi } from './stores/ui'

/** 没打开会话时的引导页：按顺序提示该做什么 */
function Welcome() {
  const presets = useApiPresets()
  const characters = useCharacters()
  const { characterId, setSettingsOpen, setSidebarOpen } = useUi()

  let tip = '在左侧选一个角色，然后新建会话'
  let action: { label: string; run: () => void } | null = null
  if (presets.data?.length === 0) {
    tip = '第一步：添加一个模型接口（OpenAI 兼容，比如 DeepSeek、OpenRouter）'
    action = { label: '打开设置', run: () => setSettingsOpen(true) }
  } else if (characters.data?.length === 0) {
    tip = '第二步：在左侧导入一张酒馆角色卡（PNG 或 JSON）'
  } else if (characterId) {
    tip = '在左侧角色下面点「新建会话」，或选一个已有的会话'
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
 * 提示条。用 popover 放进浏览器的「顶层」：设置对话框也在顶层，
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
              'pointer-events-auto max-w-lg rounded-xl px-4 py-2.5 text-left text-sm shadow-lg',
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

export function App() {
  const { chatId, previewOpen } = useUi()
  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar />
      <main className="flex min-w-0 flex-1">
        {chatId ? <ChatView key={chatId} chatId={chatId} /> : <Welcome />}
        {chatId && previewOpen && <PromptPreview chatId={chatId} />}
      </main>
      <SettingsDialog />
      <Toasts />
    </div>
  )
}
