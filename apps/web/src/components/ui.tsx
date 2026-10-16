import { type ButtonHTMLAttributes, type ReactNode, useEffect, useRef } from 'react'
import { XIcon } from './icons'

/** 通用小组件：按钮、图标按钮、头像、对话框、表单字段 */

/**
 * 拼接 class。同一类尺寸工具类（宽、高、内边距、字号……）出现多次时只保留最后一个，
 * 这样 cx(controlClass, 'w-24') 能真正把宽度改成 w-24，不会被 controlClass 里的 w-full 盖住
 * （Tailwind 生成的 CSS 顺序和 class 书写顺序无关，冲突时谁赢不确定）。
 */
const conflictGroups: [string, RegExp][] = [
  ['w', /^w-/],
  ['h', /^h-/],
  ['size', /^size-/],
  ['min-w', /^min-w-/],
  ['max-w', /^max-w-/],
  ['min-h', /^min-h-/],
  ['max-h', /^max-h-/],
  ['px', /^px-/],
  ['py', /^py-/],
  ['pl', /^pl-/],
  ['pr', /^pr-/],
  ['pt', /^pt-/],
  ['pb', /^pb-/],
  ['text-size', /^text-(xs|sm|base|lg|xl|2xl|3xl|\[[\d.]+(px|rem)\])$/],
  ['rounded', /^rounded(-(none|sm|md|lg|xl|2xl|full))?$/],
]

function groupOf(token: string): string | null {
  const parts = token.split(':')
  const utility = parts.pop() ?? ''
  const found = conflictGroups.find(([, pattern]) => pattern.test(utility))
  return found ? `${parts.join(':')}|${found[0]}` : null
}

const cx = (...classes: (string | false | null | undefined)[]) => {
  const tokens = classes.filter(Boolean).join(' ').split(/\s+/).filter(Boolean)
  const last = new Map<string, number>()
  tokens.forEach((token, index) => {
    const group = groupOf(token)
    if (group) last.set(group, index)
  })
  return tokens
    .filter((token, index) => {
      const group = groupOf(token)
      return !group || last.get(group) === index
    })
    .join(' ')
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

/**
 * 视觉规范（所有页面共用，改这里就是改全站）：
 * - 控件统一高度：md = 36px（输入框、下拉框、按钮同高，放在一行里能对齐），sm = 32px（列表行、工具栏里的小按钮）
 * - 次要按钮用白底描边，不用灰色色块；主按钮是唯一的实心紫色
 * - 圆角统一 rounded-lg，卡片 rounded-xl
 */
const variants: Record<Variant, string> = {
  primary:
    'bg-violet-600 text-white shadow-xs hover:bg-violet-500 active:bg-violet-700 disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none dark:disabled:bg-zinc-800 dark:disabled:text-zinc-500',
  secondary:
    'border border-zinc-200 bg-white text-zinc-700 shadow-xs hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-600 dark:hover:bg-zinc-800',
  ghost:
    'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
  danger: 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/60',
}

const sizes: Record<Size, string> = {
  sm: 'h-8 gap-1 px-2.5 text-[13px]',
  md: 'h-9 gap-1.5 px-3.5 text-sm',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type="button"
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors select-none disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
        sizes[size],
        variants[variant],
        className,
      )}
      {...props}
    />
  )
}

/**
 * 图标按钮。默认是 32px 的透明按钮（标题栏、列表行）；
 * outline 是 36px 的描边按钮，和输入框同高，放在输入框旁边用（刷新、显示密码……）
 */
export function IconButton({
  label,
  className,
  variant = 'ghost',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; variant?: 'ghost' | 'outline' | 'danger' }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-4',
        variant === 'outline'
          ? 'size-9 border border-zinc-200 bg-white text-zinc-500 shadow-xs hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
          : variant === 'danger'
            ? 'size-8 text-zinc-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/60 dark:hover:text-red-400'
            : 'size-8 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
        className,
      )}
      {...props}
    />
  )
}

/** 小标签（版本、来源、状态等） */
export const badgeClass =
  'inline-flex h-5 items-center rounded-md bg-zinc-100 px-1.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'

/** 头像：有图片用图片，没有就用名字的第一个字 */
export function Avatar({ name, url, size = 40 }: { name: string; url?: string | null; size?: number }) {
  const style = { width: size, height: size }
  if (url) {
    return <img src={url} alt="" loading="lazy" style={style} className="shrink-0 rounded-full object-cover" />
  }
  return (
    <div
      style={style}
      className="flex shrink-0 items-center justify-center rounded-full bg-violet-100 text-sm font-semibold text-violet-700 dark:bg-violet-950 dark:text-violet-300"
    >
      {name.slice(0, 1)}
    </div>
  )
}

/** 基于原生 <dialog> 的模态框，自带遮罩、Esc 关闭和焦点管理 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  className,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className={cx(
        'm-auto w-[min(720px,calc(100vw-32px))] rounded-2xl bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:bg-zinc-900 dark:text-zinc-100',
        className,
      )}
    >
      {open && (
        <div className="flex max-h-[85dvh] flex-col">
          <header className="flex items-center justify-between border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
            <h2 className="font-semibold">{title}</h2>
            <IconButton label="关闭" onClick={onClose}>
              <XIcon />
            </IconButton>
          </header>
          <div className="overflow-y-auto p-5">{children}</div>
        </div>
      )}
    </dialog>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: 控件由 children 传入
    <label className="block space-y-1.5">
      <span className="block text-[13px] font-medium text-zinc-800 dark:text-zinc-200">{label}</span>
      {children}
      {hint && <span className="block text-xs leading-relaxed text-zinc-500">{hint}</span>}
    </label>
  )
}

/** 输入框的边框和底色（不含高度），多行文本框也用它 */
export const inputClass =
  'w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-zinc-400 hover:border-zinc-300 focus:border-violet-500 focus:ring-3 focus:ring-violet-500/15 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-600'

/** 单行控件（输入框、下拉框）：固定 36px 高，和按钮对齐 */
export const controlClass = `${inputClass} h-9 py-0`

/** 下拉框：去掉系统箭头，统一画一个 */
export const selectClass = `${controlClass} select-chevron cursor-pointer appearance-none pr-9`

export { cx }
