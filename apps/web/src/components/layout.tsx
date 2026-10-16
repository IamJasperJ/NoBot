import { type ReactNode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useUi } from '../stores/ui'
import { XIcon } from './icons'
import { cx, IconButton } from './ui'

/**
 * 管理类页面（角色、世界书、预设、连接、人设、扩展、日志）的统一布局。
 * 页面本身渲染在左侧的侧栏面板里（聊天区始终保留在中间）：
 * - 列表一直在侧栏面板里
 * - 详情有两种放法（detailIn）：
 *   - overlay（默认）：内容多的编辑器，用传送门（portal）渲染进 App 的覆盖层，盖在聊天区上面
 *   - panel：内容少的设置，直接在侧栏面板里替换列表显示，带返回按钮
 * 关闭侧栏面板（再点一次左侧导航）时，页面整体卸载，覆盖层也随之消失。
 */
export function ManagerLayout({
  title,
  actions,
  list,
  detail,
  showDetailOnMobile,
  detailIn = 'overlay',
}: {
  title: string
  /** 标题栏右侧的按钮（新建、导入……） */
  actions?: ReactNode
  list: ReactNode
  detail: ReactNode
  /** 是否选中了某个对象（有详情可显示）。名字是历史原因，现在在所有屏幕宽度上都表示「显示详情」 */
  showDetailOnMobile: boolean
  detailIn?: 'overlay' | 'panel'
}) {
  const setSidebarOpen = useUi((s) => s.setSidebarOpen)
  const overlayRoot = useOverlayRoot()

  if (detailIn === 'panel' && showDetailOnMobile) {
    return <div className="flex h-full min-w-0 flex-col overflow-y-auto">{detail}</div>
  }

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 px-3">
        <h1 className="flex-1 truncate font-semibold">{title}</h1>
        {actions}
        <IconButton label="关闭侧栏" className="md:hidden" onClick={() => setSidebarOpen(false)}>
          <XIcon />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">{list}</div>
      {detailIn === 'overlay' &&
        showDetailOnMobile &&
        overlayRoot &&
        createPortal(<div className="h-full overflow-y-auto">{detail}</div>, overlayRoot)}
    </div>
  )
}

/** App 里覆盖层容器的 DOM 节点（id="overlay-root"） */
function useOverlayRoot() {
  const [el, setEl] = useState<HTMLElement | null>(null)
  useEffect(() => setEl(document.getElementById('overlay-root')), [])
  return el
}

/** 列表里的一项 */
export function ListItem({
  active,
  onClick,
  children,
  trailing,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
  trailing?: ReactNode
}) {
  return (
    <div
      className={cx(
        'group flex items-center gap-2 rounded-lg px-2 py-1.5',
        active ? 'bg-violet-100 dark:bg-violet-950' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60',
      )}
    >
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm" onClick={onClick}>
        {children}
      </button>
      {trailing}
    </div>
  )
}

/** 详情的标题栏。onBack 关闭详情（覆盖层模式下是关闭覆盖层，面板模式下是回到列表） */
export function DetailHeader({
  title,
  onBack,
  actions,
}: {
  title: ReactNode
  onBack: () => void
  actions?: ReactNode
}) {
  return (
    <header className="sticky top-0 z-10 flex min-h-14 flex-wrap items-center gap-2 border-b border-zinc-200 bg-white/90 px-4 py-2 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
      <IconButton label="关闭" onClick={onBack}>
        <XIcon />
      </IconButton>
      <h2 className="min-w-0 flex-1 truncate font-semibold">{title}</h2>
      {actions}
    </header>
  )
}

/** 没有选中任何对象时的占位 */
export function EmptyDetail({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center p-8 text-sm text-zinc-400">{text}</div>
}
