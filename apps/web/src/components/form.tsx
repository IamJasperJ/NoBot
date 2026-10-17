import { createContext, type ReactNode, useContext, useId, useState } from 'react'
import { t } from '../i18n'
import { ChevronRightIcon, InfoIcon } from './icons'
import { controlClass, cx, inputClass, selectClass } from './ui'

/**
 * 表单控件。所有设置页面（生成预设、世界书条目、角色编辑……）统一用这些组件，保证外观和交互一致。
 * 规则：
 * - 每个控件都有 label，hint 写一句话说明作用
 * - notImplemented 为 true 时显示「未实现」标记，控件照样可以编辑和保存，只是暂时不生效
 *
 * 两种排版：
 * - 普通：标签在上、控件在下、说明常驻在下方。用在设置项少的页面（连接、角色编辑……）
 * - 紧凑（放在 DenseGrid 或 <Section dense> 里时自动生效）：一行一项，标签在左、控件在右，
 *   说明收进标签旁的 ⓘ，点开才显示；宽屏自动分多列。设置项多的页面用它，一屏能看到大部分配置
 */

const DenseContext = createContext(false)

/** 当前是否处在紧凑排版里（扩展的自定义控件也可以用它决定怎么排） */
export const useDense = () => useContext(DenseContext)

/** 紧凑网格：每列至少 16rem，放得下几列就分几列；col-span-full 的子元素独占一行 */
export const denseGridClass =
  'grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] items-start gap-x-6 gap-y-1'

export function DenseGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <DenseContext.Provider value={true}>
      <div className={cx(denseGridClass, className)}>{children}</div>
    </DenseContext.Provider>
  )
}

/**
 * 紧凑排版的标签列：所有行同宽，控件左边对齐成一条线。
 * 每行是一个容器（@container）：行宽不到 20rem（比如窄侧栏）时标签占 40%，给滑块留出位置
 */
export const denseLabelClass = 'w-[40%] flex-none @xs:w-36'

/** 紧凑排版下单行控件的尺寸：32px 高、13px 字 */
export const denseControlClass = cx(controlClass, 'h-8 px-2.5 text-[13px]')
export const denseSelectClass = cx(selectClass, 'h-8 pl-2.5 text-[13px]')

/** 说明按钮：紧凑排版下说明默认收起，点 ⓘ 展开（悬停也能看到） */
export function HintButton({ hint, open, onToggle }: { hint: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      title={hint}
      aria-label={t('说明')}
      aria-expanded={open}
      onClick={onToggle}
      className={cx(
        'inline-flex size-5 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 [&_svg]:size-3.5',
        open && 'text-violet-600 dark:text-violet-400',
      )}
    >
      <InfoIcon />
    </button>
  )
}

/**
 * 紧凑排版的一行：左边标签（+ⓘ），右边控件。
 * wide 表示独占整行（多行文本、带附加按钮的输入框……）；stack 表示标签在上、控件在下（多行文本）。
 */
export function DenseRow({
  id,
  label,
  hint,
  notImplemented,
  disabled,
  wide,
  stack,
  labelClassName,
  children,
}: {
  id?: string | undefined
  label: string
  hint?: string | undefined
  notImplemented?: boolean | undefined
  disabled?: boolean | undefined
  wide?: boolean | undefined
  stack?: boolean | undefined
  /** 改标签列的样式（默认所有行同宽，控件从同一条竖线开始） */
  labelClassName?: string | undefined
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const title = (
    <span className={cx('flex min-w-0 items-center gap-0.5', !stack && denseLabelClass, labelClassName)}>
      {/* 最多两行：英文标签普遍比中文长，单行截断会看不全；两行仍放得进 36px 的行高 */}
      <label
        htmlFor={id}
        title={label}
        className="line-clamp-2 min-w-0 text-[13px] leading-tight break-words text-zinc-700 dark:text-zinc-300"
      >
        {label}
      </label>
      {notImplemented && <NotImplementedDot />}
      {hint && <HintButton hint={hint} open={open} onToggle={() => setOpen(!open)} />}
    </span>
  )
  return (
    <div className={cx('@container min-w-0', (wide || stack) && 'col-span-full', disabled && 'opacity-60')}>
      {stack ? (
        <div className="space-y-1 py-1">
          <div className="flex min-h-6 items-center">{title}</div>
          {children}
        </div>
      ) : (
        <div className="flex min-h-9 min-w-0 items-center gap-2">
          {title}
          {children}
        </div>
      )}
      {open && hint && <p className="pb-1.5 text-xs leading-relaxed text-zinc-500">{hint}</p>}
    </div>
  )
}

/** 「未实现」标记 */
export function NotImplemented() {
  return (
    <span className="ml-1.5 shrink-0 whitespace-nowrap rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
      {t('未实现')}
    </span>
  )
}

/** 紧凑排版里的「未实现」：标签旁一个小黄点，不占标签的位置（文字标记会把标签挤得看不全） */
export function NotImplementedDot() {
  return (
    <span
      role="img"
      aria-label={t('未实现')}
      title={t('未实现：可以先设置，以后生效')}
      className="ml-1 inline-block size-1.5 shrink-0 rounded-full bg-amber-500"
    />
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
  const dense = useDense()
  const id = useId()
  if (dense)
    return (
      // 开关的标签可以比标签列更长（开关很窄，不怕把它往右推），这样长标签也不会被截断
      <DenseRow
        id={id}
        label={label}
        hint={hint}
        notImplemented={notImplemented}
        disabled={disabled}
        labelClassName="w-auto min-w-[40%] flex-initial @xs:w-auto @xs:min-w-36"
      >
        <Toggle id={id} checked={checked} onChange={onChange} label={label} {...(disabled ? { disabled } : {})} />
      </DenseRow>
    )
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
  id,
  checked,
  onChange,
  label,
  disabled,
}: {
  id?: string
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      id={id}
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
  const dense = useDense()
  const id = useId()
  if (dense)
    return (
      <DenseRow id={id} label={label} hint={hint} notImplemented={notImplemented} disabled={disabled}>
        <input
          id={id}
          className={cx(denseControlClass, 'min-w-0 flex-1')}
          type={type}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      </DenseRow>
    )
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
  const dense = useDense()
  const id = useId()
  if (dense)
    return (
      <DenseRow id={id} label={label} hint={hint} notImplemented={notImplemented} disabled={disabled} stack>
        <textarea
          id={id}
          className={cx(inputClass, 'resize-y px-2.5 py-1.5 text-[13px] leading-relaxed', mono && 'font-mono text-xs')}
          rows={rows}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      </DenseRow>
    )
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
}: BaseProps & { value: T; onChange: (v: T) => void; options: { value: T; label: string; disabled?: boolean }[] }) {
  const dense = useDense()
  const id = useId()
  if (dense)
    return (
      <DenseRow id={id} label={label} hint={hint} notImplemented={notImplemented} disabled={disabled}>
        <select
          id={id}
          className={cx(denseSelectClass, 'min-w-0 flex-1')}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value as T)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled}>
              {o.label}
            </option>
          ))}
        </select>
      </DenseRow>
    )
  return (
    <label className="block space-y-1.5">
      <Label label={label} notImplemented={notImplemented} />
      <select className={selectClass} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
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
  const dense = useDense()
  const id = useId()
  if (dense) {
    const box = (
      <input
        id={id}
        type="number"
        className={cx(denseControlClass, 'shrink-0 px-1.5 text-right tabular-nums', slider ? 'w-16' : 'w-28')}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (e.target.value !== '' && Number.isFinite(v)) onChange(clamp(v))
        }}
      />
    )
    return (
      <DenseRow id={id} label={label} hint={hint} notImplemented={notImplemented} disabled={disabled}>
        {slider && (
          <input
            type="range"
            className="block min-w-0 flex-1 accent-violet-600"
            value={value}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            aria-label={t('{label}滑块', { label })}
            onChange={(e) => onChange(Number(e.target.value))}
          />
        )}
        {box}
      </DenseRow>
    )
  }
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
        aria-label={t('{label}滑块', { label })}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <Hint hint={hint} />
    </div>
  )
}

/**
 * 多选：一排可点的小标签，选中的高亮。紧凑排版下标签在左；普通排版下标题在上。
 * 选项可以标 notImplemented（显示但带「未实现」提示）。
 */
export function CheckGroupField<T extends string>({
  label,
  hint,
  notImplemented,
  disabled,
  value,
  onChange,
  options,
}: BaseProps & {
  value: T[]
  onChange: (v: T[]) => void
  options: { value: T; label: string; notImplemented?: boolean }[]
}) {
  const dense = useDense()
  const chips = (
    <fieldset aria-label={label} className="flex min-w-0 flex-1 flex-wrap gap-1.5 py-1" disabled={disabled}>
      {options.map((o) => {
        const on = value.includes(o.value)
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            title={o.notImplemented ? t('{label}（未实现，可以先勾选，以后生效）', { label: o.label }) : o.label}
            onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
            className={cx(
              'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[13px] transition-colors disabled:opacity-50',
              on
                ? 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/60 dark:text-violet-300'
                : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300',
            )}
          >
            {on && <span aria-hidden="true" className="size-1.5 rounded-full bg-violet-500" />}
            {o.label}
            {o.notImplemented && <span className="text-[10px] text-amber-600 dark:text-amber-400">{t('未实现')}</span>}
          </button>
        )
      })}
    </fieldset>
  )
  if (dense)
    return (
      <DenseRow label={label} hint={hint} notImplemented={notImplemented} disabled={disabled} wide>
        {chips}
      </DenseRow>
    )
  return (
    <div className="space-y-1.5">
      <Label label={label} notImplemented={notImplemented} />
      {chips}
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
      {...(hint ? { hint: t('{hint}（一行一个）', { hint }) } : { hint: t('一行一个') })}
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
  dense = false,
}: {
  title: string
  description?: string
  children: ReactNode
  defaultOpen?: boolean
  /** 紧凑排版：内容用 DenseGrid，一行一项、宽屏多列 */
  dense?: boolean
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40"
    >
      <summary
        className={cx(
          'flex cursor-pointer list-none items-center gap-3 rounded-xl select-none hover:bg-zinc-50 dark:hover:bg-zinc-800/40 [&::-webkit-details-marker]:hidden',
          dense ? 'px-3 py-2.5' : 'px-4 py-3',
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{title}</div>
          {description && <div className="mt-0.5 text-xs text-zinc-500">{description}</div>}
        </div>
        <ChevronRightIcon className="size-4 shrink-0 text-zinc-400 transition-transform group-open:rotate-90" />
      </summary>
      {dense ? (
        <DenseGrid className="border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">{children}</DenseGrid>
      ) : (
        <div className="space-y-5 border-t border-zinc-100 px-4 py-4 dark:border-zinc-800">{children}</div>
      )}
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
