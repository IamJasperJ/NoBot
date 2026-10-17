import { useState } from 'react'
import { t } from '../i18n'
import { XIcon } from './icons'
import { cx } from './ui'

/** 小标签的外观（列表、筛选、编辑共用） */
/** 标签的形状（不含颜色，方便选中态换色时不和底色冲突） */
export const tagShape = 'inline-flex h-6 max-w-full items-center gap-1 rounded-md px-2 text-xs'
export const tagClass = `${tagShape} bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200`

/**
 * 标签输入：已有标签显示成小块，可以点 × 删除；输入框里回车、逗号或 Tab 添加，空输入时退格删除最后一个。
 * suggestions 是其他角色已经用过的标签，聚焦时显示在下面，点一下就加上，方便统一分类
 */
export function TagInput({
  value,
  onChange,
  suggestions = [],
  disabled,
  label = t('标签'),
}: {
  value: string[]
  onChange: (value: string[]) => void
  suggestions?: string[]
  disabled?: boolean
  label?: string
}) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const add = (raw: string) => {
    const tags = raw
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter((t) => t && !value.includes(t))
    if (tags.length) onChange([...value, ...new Set(tags)])
    setText('')
  }
  const candidates = suggestions
    .filter((t) => !value.includes(t) && t.toLocaleLowerCase().includes(text.trim().toLocaleLowerCase()))
    .slice(0, 16)
  return (
    <div className="space-y-1.5">
      <div
        className={cx(
          'flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-zinc-200 bg-white px-1.5 py-1 shadow-xs transition-[border-color,box-shadow] dark:border-zinc-700 dark:bg-zinc-900',
          focused && 'border-violet-500 ring-3 ring-violet-500/15',
          disabled && 'opacity-60',
        )}
      >
        {value.map((tag) => (
          <span key={tag} className={tagClass}>
            <span className="truncate">{tag}</span>
            <button
              type="button"
              aria-label={t('删除标签 {tag}', { tag })}
              disabled={disabled}
              className="-mr-1 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-100 [&_svg]:size-3"
              onClick={() => onChange(value.filter((t) => t !== tag))}
            >
              <XIcon />
            </button>
          </span>
        ))}
        <input
          aria-label={label}
          className="h-6 min-w-24 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-zinc-400"
          placeholder={value.length ? '' : t('输入后按回车添加')}
          value={text}
          disabled={disabled}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            if (text.trim()) add(text)
          }}
          onChange={(e) => {
            if (/[,，]/.test(e.target.value)) add(e.target.value)
            else setText(e.target.value)
          }}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === 'Tab') && text.trim()) {
              e.preventDefault()
              add(text)
            } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
          }}
        />
      </div>
      {focused && candidates.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {candidates.map((tag) => (
            <button
              key={tag}
              type="button"
              className={cx(tagClass, 'hover:bg-violet-100 hover:text-violet-700 dark:hover:bg-violet-950')}
              // 用 pointerdown 抢在输入框失焦前添加
              onPointerDown={(e) => {
                e.preventDefault()
                onChange([...value, tag])
              }}
            >
              + {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
