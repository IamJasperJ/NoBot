import type { ReactNode } from 'react'
import { ChevronRightIcon } from './icons'
import { controlClass, cx, inputClass, selectClass } from './ui'

/**
 * 表单控件。所有设置页面（生成预设、世界书条目、角色编辑……）统一用这些组件，保证外观和交互一致。
 * 规则：
 * - 每个控件都有 label，hint 写一句话说明作用（显示在下方的小字）
 * - notImplemented 为 true 时显示「未实现」标记，控件照样可以编辑和保存，只是暂时不生效
 */

/** 「未实现」标记 */
export function NotImplemented() {
  return (
    <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
      未实现
    </span>
  )
}

interface BaseProps {
  label: string
  hint?: string
  notImplemented?: boolean
  disabled?: boolean
}

function Label({ label, notImplemented }: { label: string; notImplemented?: boolean | undefined }) {
  return (
    <span className="block text-[13px] font-medium text-zinc-800 dark:text-zinc-200">
      {label}
      {notImplemented && <NotImplemented />}
    </span>
  )
}

function Hint({ hint }: { hint?: string | undefined }) {
  return hint ? <span className="block text-xs leading-relaxed text-zinc-500">{hint}</span> : null
}

/** 开关（布尔值）：文字在左、开关在右，和其他设置项左对齐 */
export function SwitchField({
  label,
  hint,
  notImplemented,
  disabled,
  checked,
  onChange,
}: BaseProps & { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: 开关按钮在 label 内部，点文字也能切换
    <label className={cx('flex cursor-pointer items-start justify-between gap-4', disabled && 'opacity-50')}>
      <span className="min-w-0 space-y-0.5">
        <Label label={label} notImplemented={notImplemented} />
        <Hint hint={hint} />
      </span>
      <Toggle checked={checked} onChange={onChange} label={label} {...(disabled ? { disabled } : {})} />
    </label>
  )
}

/**
 * 紧凑开关：没有标签和说明，用在列表行里（比如 Prompt 条目、世界书条目、扩展的启用开关）。
 * label 只给读屏软件和鼠标悬停提示用。
 */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        // 列表行本身通常也可点击（展开），开关不要触发行的点击
        e.stopPropagation()
        onChange(!checked)
      }}
      className={cx(
        'relative mt-px h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-violet-600' : 'bg-zinc-200 dark:bg-zinc-700',
      )}
    >
      <span
        className={cx(
          'absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform',
          checked && 'translate-x-4',
        )}
      />
    </button>
  )
}

/** 单行文本 */
export function TextField({
  label,
  hint,
  notImplemented,
  disabled,
  value,
  onChange,
  placeholder,
  type = 'text',
}: BaseProps & {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: 'text' | 'password' | 'url'
}) {
  return (
    <label className="block space-y-1.5">
      <Label label={label} notImplemented={notImplemented} />
      <input
        className={controlClass}
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      <Hint hint={hint} />
    </label>
  )
}

/** 多行文本 */
export function TextAreaField({
  label,
  hint,
  notImplemented,
  disabled,
  value,
  onChange,
  placeholder,
  rows = 4,
  mono = false,
}: BaseProps & {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
  /** 等宽字体（JSON、正则等） */
  mono?: boolean
}) {
  return (
    <label className="block space-y-1.5">
      <Label label={label} notImplemented={notImplemented} />
      <textarea
        className={cx(inputClass, 'resize-y leading-relaxed', mono && 'font-mono text-xs')}
        rows={rows}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      <Hint hint={hint} />
    </label>
  )
}

/** 下拉选择 */
export function SelectField<T extends string>({
  label,
  hint,
  notImplemented,
  disabled,
  value,
  onChange,
  options,
}: BaseProps & { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <label className="block space-y-1.5">
      <Label label={label} notImplemented={notImplemented} />
      <select className={selectClass} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Hint hint={hint} />
    </label>
  )
}

/**
 * 数字：滑块 + 输入框。slider 为 false 时只显示输入框（适合上下文长度这类范围很大的值）。
 * 输入框里输入非法值时不触发 onChange，失焦后恢复成当前值。
 */
export function NumberField({
  label,
  hint,
  notImplemented,
  disabled,
  value,
  onChange,
  min,
  max,
  step = 1,
  slider = true,
}: BaseProps & {
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  slider?: boolean
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  const input = (
    <input
      type="number"
      className={cx(controlClass.replace('w-full ', ''), 'tabular-nums', slider ? 'h-8 w-20 text-right' : 'w-40')}
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => {
        const v = Number(e.target.value)
        if (e.target.value !== '' && Number.isFinite(v)) onChange(clamp(v))
      }}
    />
  )
  // 没有滑块时和文本框一样：标题在上、输入框在下；有滑块时数值框放在标题右侧
  if (!slider)
    return (
      <div className="space-y-1.5">
        <Label label={label} notImplemented={notImplemented} />
        {input}
        <Hint hint={hint} />
      </div>
    )
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate">
          <Label label={label} notImplemented={notImplemented} />
        </span>
        {input}
      </div>
      <input
        type="range"
        className="block w-full accent-violet-600"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={`${label}滑块`}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <Hint hint={hint} />
    </div>
  )
}

/** 字符串列表（停止序列、关键词等），一行一个 */
export function ListField({
  label,
  hint,
  notImplemented,
  disabled,
  value,
  onChange,
  placeholder,
}: BaseProps & { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  return (
    <TextAreaField
      label={label}
      {...(hint ? { hint: `${hint}（一行一个）` } : { hint: '一行一个' })}
      {...(notImplemented ? { notImplemented } : {})}
      {...(disabled ? { disabled } : {})}
      {...(placeholder ? { placeholder } : {})}
      rows={3}
      value={value.join('\n')}
      onChange={(v) => onChange(v.split('\n').filter((line, i, arr) => line !== '' || i === arr.length - 1))}
    />
  )
}

/** 可折叠的分组卡片 */
export function Section({
  title,
  description,
  children,
  defaultOpen = true,
}: {
  title: string
  description?: string
  children: ReactNode
  defaultOpen?: boolean
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-4 py-3 select-none hover:bg-zinc-50 dark:hover:bg-zinc-800/40 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{title}</div>
          {description && <div className="mt-0.5 text-xs text-zinc-500">{description}</div>}
        </div>
        <ChevronRightIcon className="size-4 shrink-0 text-zinc-400 transition-transform group-open:rotate-90" />
      </summary>
      <div className="space-y-5 border-t border-zinc-100 px-4 py-4 dark:border-zinc-800">{children}</div>
    </details>
  )
}

/** 页签 */
export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T
  onChange: (v: T) => void
  tabs: { id: T; label: string }[]
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-800">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cx(
            'flex-1 rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap',
            value === t.id ? 'bg-white shadow-sm dark:bg-zinc-950' : 'text-zinc-500',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
