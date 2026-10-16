import { type ReactNode, useEffect, useRef } from 'react'
import { DotsIcon } from './icons'
import { cx } from './ui'

/**
 * 下拉菜单（「⋯」更多操作）。基于 <details>：点按钮展开，点菜单项或点外面收起。
 * 低频操作（复制、导出、删除……）放这里，标题栏只留最常用的一两个按钮。
 */
export function Menu({
  label = '更多操作',
  children,
  align = 'right',
}: {
  label?: string
  children: ReactNode
  align?: 'left' | 'right'
}) {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (ref.current?.open && event.target instanceof Node && !ref.current.contains(event.target))
        ref.current.open = false
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [])
  return (
    <details ref={ref} className="relative">
      <summary
        aria-label={label}
        title={label}
        className="inline-flex size-8 cursor-pointer list-none items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 [&::-webkit-details-marker]:hidden [&_svg]:size-4"
      >
        <DotsIcon />
      </summary>
      <div
        role="menu"
        tabIndex={-1}
        className={cx(
          'absolute z-30 mt-1 min-w-44 rounded-xl border border-zinc-200 bg-white p-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900',
          align === 'right' ? 'right-0' : 'left-0',
        )}
        onClick={() => {
          if (ref.current) ref.current.open = false
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && ref.current) ref.current.open = false
        }}
      >
        {children}
      </div>
    </details>
  )
}

export function MenuEntry({
  icon,
  children,
  onClick,
  danger,
  disabled,
}: {
  icon?: ReactNode
  children: ReactNode
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left disabled:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0',
        danger
          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/60'
          : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800',
      )}
    >
      {icon}
      {children}
    </button>
  )
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-zinc-100 dark:bg-zinc-800" />
}
