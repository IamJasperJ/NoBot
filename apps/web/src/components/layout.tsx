import type { ReactNode } from 'react'
import { useUi } from '../stores/ui'
import { MenuIcon } from './icons'
import { cx, IconButton } from './ui'

/**
 * 管理类页面（角色、世界书、预设、连接、人设、扩展、日志）的统一布局：
 * 左边是列表（ListPane），右边是详情（DetailPane）。手机上一次只显示一栏：选中了对象就显示详情。
 */
export function ManagerLayout({
  title,
  actions,
  list,
  detail,
  showDetailOnMobile,
}: {
  title: string
  /** 标题栏右侧的按钮（新建、导入……） */
  actions?: ReactNode
  list: ReactNode
  detail: ReactNode
  /** 手机上是否显示详情栏（通常是「选中了某个对象」） */
  showDetailOnMobile: boolean
}) {
  const setSidebarOpen = useUi((s) => s.setSidebarOpen)
  return (
    <div className="flex h-full min-w-0 flex-1">
      <section
        className={cx(
          'flex w-full flex-col border-r border-zinc-200 md:w-72 md:shrink-0 dark:border-zinc-800',
          showDetailOnMobile && 'max-md:hidden',
        )}
      >
        <header className="flex h-14 shrink-0 items-center gap-2 px-3">
          <IconButton label="打开导航" className="md:hidden" onClick={() => setSidebarOpen(true)}>
            <MenuIcon />
          </IconButton>
          <h1 className="flex-1 truncate font-semibold">{title}</h1>
          {actions}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">{list}</div>
      </section>
      <section className={cx('min-w-0 flex-1 overflow-y-auto', !showDetailOnMobile && 'max-md:hidden')}>
        {detail}
      </section>
    </div>
  )
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

/** 详情页的标题栏：手机上带返回按钮 */
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
    <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-zinc-200 bg-white/90 px-4 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
      <button type="button" className="text-sm text-violet-600 md:hidden" onClick={onBack}>
        ‹ 返回
      </button>
      <h2 className="min-w-0 flex-1 truncate font-semibold">{title}</h2>
      {actions}
    </header>
  )
}

/** 没有选中任何对象时的占位 */
export function EmptyDetail({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center p-8 text-sm text-zinc-400">{text}</div>
}
