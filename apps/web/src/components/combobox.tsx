import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../i18n'
import { denseControlClass, useDense } from './form'
import { ChevronDownIcon } from './icons'
import { controlClass, cx } from './ui'

export type Option = { value: string; label: string }

/**
 * 可输入的下拉框：可以从列表里选，也可以直接输入任意值。
 * 不用原生 <datalist>——它会按输入框里已有的文字过滤候选，输入框有值时就只剩一两个选项，像是被限制了。
 * 这里点开下拉时总是显示全部候选，只有用户开始打字后才按输入过滤。
 */
export function Combobox({
  value,
  onChange,
  options,
  disabled,
  placeholder,
  label,
  secret,
  id,
  className,
}: {
  value: string
  onChange: (value: string) => void
  options: Option[]
  disabled: boolean
  placeholder?: string | undefined
  label: string
  secret?: boolean
  id?: string
  /** 外层容器的 class（紧凑排版里用 flex-1 占满剩余宽度） */
  className?: string
}) {
  const dense = useDense()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const listId = useId()
  const filtered =
    query === null || !query.trim()
      ? options
      : options.filter((option) => `${option.value} ${option.label}`.toLowerCase().includes(query.trim().toLowerCase()))
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target) &&
        !document.getElementById(listId)?.contains(event.target)
      ) {
        setOpen(false)
        setQuery(null)
      }
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open, listId])
  // 列表用 fixed 定位：放在可滚动的侧栏、对话框里时不会被父容器的 overflow 裁掉。
  // 滚动或改变窗口大小时重新对齐
  const [place, setPlace] = useState<CSSProperties>({})
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const rect = root.current?.getBoundingClientRect()
      if (!rect) return
      const gutter = 8
      // 默认右边与输入框对齐向左展开；输入框靠左、右侧空间更大时改为左边对齐向右展开。
      // 宽度上限取展开那一侧的可用空间，保证列表不越出视口
      const leftRoom = rect.right - gutter
      const rightRoom = window.innerWidth - rect.left - gutter
      const toRight = rightRoom > leftRoom
      const maxWidth = Math.min(512, toRight ? rightRoom : leftRoom)
      const below = window.innerHeight - rect.bottom - gutter
      const above = rect.top - gutter
      // 下方放不下且上方更宽敞时向上弹出
      const up = below < 160 && above > below
      setPlace({
        position: 'fixed',
        minWidth: Math.min(rect.width, maxWidth),
        maxWidth,
        ...(toRight ? { left: rect.left } : { right: window.innerWidth - rect.right }),
        ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
        maxHeight: Math.min(256, up ? above : below),
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])
  const pick = (option: Option) => {
    onChange(option.value)
    setOpen(false)
    setQuery(null)
  }
  return (
    <div ref={root} className={cx('relative', className)}>
      <input
        id={id}
        className={cx(dense ? denseControlClass : controlClass, 'pr-9')}
        type={secret ? 'password' : 'text'}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value)
          setQuery(e.target.value)
          setActive(0)
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
            setActive((i) => Math.min(i + 1, filtered.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => Math.max(i - 1, 0))
          } else if (e.key === 'Enter' && open && filtered[active]) {
            e.preventDefault()
            pick(filtered[active])
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation()
            setOpen(false)
            setQuery(null)
          }
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={t('展开{label}候选', { label })}
        disabled={disabled}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
        onClick={() => {
          setQuery(null)
          setOpen(!open)
        }}
      >
        <ChevronDownIcon className={cx('size-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open &&
        filtered.length > 0 &&
        createPortal(
          // 列表至少和输入框一样宽，候选名更长时向左展开（不越出视口），仍放不下就换行，保证能看到完整名字
          <div
            id={listId}
            role="listbox"
            style={place}
            className="z-50 w-max overflow-y-auto rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
          >
            {filtered.map((option, index) => (
              <div
                key={option.value}
                role="option"
                tabIndex={-1}
                aria-selected={option.value === value}
                onPointerDown={(e) => {
                  e.preventDefault()
                  pick(option)
                }}
                onPointerEnter={() => setActive(index)}
                className={cx(
                  'flex cursor-pointer items-center gap-2 px-3 py-1.5',
                  index === active && 'bg-zinc-100 dark:bg-zinc-800',
                  option.value === value && 'font-medium text-violet-700 dark:text-violet-300',
                )}
              >
                <span className="min-w-0 flex-1 break-all">{option.label}</span>
                {option.label !== option.value && (
                  <span className="max-w-[45%] shrink-0 font-mono text-[11px] break-all text-zinc-400">
                    {option.value}
                  </span>
                )}
              </div>
            ))}
          </div>,
          // 渲染到 body（在模态对话框里时渲染到对话框，保证仍在顶层之上），避免被祖先的 overflow 裁剪、被毛玻璃的 backdrop-filter 改变 fixed 的参照
          root.current?.closest('dialog') ?? document.body,
        )}
    </div>
  )
}
