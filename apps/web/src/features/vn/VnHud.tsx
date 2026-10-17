import type { StateField, StateSchema } from '@ai-parter/shared'
import { useEffect, useRef, useState } from 'react'
import { ChevronDownIcon } from '../../components/icons'
import { cx } from '../../components/ui'
import { t } from '../../i18n'

/**
 * VN 的状态面板（HUD）：按状态定义（schema）显示变量。
 * - meter：带上限的条，有阶段（stages）时显示阶段名（好感度的「朋友 / 心动」）
 * - number / text / badge：一行「名字 值」；list：一排小标签
 * - 数值变化时在值旁边飘出 +3 / −5（玩法预设「数值变化飘字」）
 * - 点值可以手动修改（写成手动补丁，跟着分支走）
 * - 收起时只显示常驻（pin）的变量；手机上和「顶部一行」位置时是一行摘要，点开看全部
 */

type Vars = Record<string, unknown>

const COLORS: Record<string, string> = {
  red: 'bg-rose-500',
  green: 'bg-emerald-500',
  blue: 'bg-sky-500',
  yellow: 'bg-amber-400',
  violet: 'bg-violet-500',
}

/** meter 的上限：数字，或另一个变量的名字 */
function maxOf(field: StateField, vars: Vars): number | null {
  if (typeof field.max === 'number') return field.max
  if (typeof field.max === 'string') {
    const value = Number(vars[field.max])
    return Number.isFinite(value) ? value : null
  }
  return null
}

/** 落在哪个阶段：stages 按阈值升序，取 ≤ 当前值的最后一个 */
function stageOf(field: StateField, value: number): string | null {
  let name: string | null = null
  for (const [threshold, stage] of field.stages ?? []) if (value >= threshold) name = stage
  return name
}

/** 值显示成文字 */
function display(field: StateField | undefined, value: unknown, vars: Vars): string {
  if (value === undefined || value === null || value === '') return '—'
  if (Array.isArray(value)) return value.length ? value.map(String).join(t('、')) : '—'
  if (field?.type === 'meter' && typeof value === 'number') {
    const max = maxOf(field, vars)
    return max === null ? String(value) : `${value}/${max}`
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/** 两份变量之间的数值变化（只看数字），用来飘字 */
function numericDeltas(prev: Vars, next: Vars): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(next)) {
    const before = prev[key]
    if (typeof value === 'number' && typeof before === 'number' && value !== before) out[key] = value - before
  }
  return out
}

export function VnHud({
  schema,
  vars,
  position,
  floatDelta,
  mobile,
  onEdit,
}: {
  schema: StateSchema
  vars: Vars
  position: 'top-right' | 'top-left' | 'top-bar'
  floatDelta: boolean
  mobile: boolean
  /** 手动修改一个变量；不传时不能编辑（比如在重演旧回复） */
  onEdit?: (key: string, value: unknown) => Promise<void>
}) {
  const keys = Object.keys(schema)
  const pinned = keys.filter((k) => schema[k]?.pin)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null)

  // 飘字：变量变了就记下差值，1.6 秒后消失。第一次渲染不飘
  const prev = useRef<Vars | null>(null)
  const [deltas, setDeltas] = useState<{ id: number; values: Record<string, number> } | null>(null)
  useEffect(() => {
    const before = prev.current
    prev.current = vars
    if (!before || !floatDelta) return
    const values = numericDeltas(before, vars)
    if (!Object.keys(values).length) return
    const id = Date.now()
    setDeltas({ id, values })
    const timer = setTimeout(() => setDeltas((d) => (d?.id === id ? null : d)), 1600)
    return () => clearTimeout(timer)
  }, [vars, floatDelta])

  if (!keys.length) return null
  const bar = mobile || position === 'top-bar'
  const shown = open ? keys : pinned.length ? pinned : keys.slice(0, 3)

  const save = async () => {
    if (!editing || !onEdit) return
    const field = schema[editing.key]
    const text = editing.text.trim()
    const value =
      field?.type === 'list'
        ? text
            .split(/[、,，\n]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : field?.type === 'meter' || field?.type === 'number'
          ? Number(text)
          : text
    if (typeof value === 'number' && !Number.isFinite(value)) return
    await onEdit(editing.key, value)
    setEditing(null)
  }

  const row = (key: string) => {
    const field = schema[key] as StateField
    const value = vars[key]
    const label = field.label || key
    const delta = deltas?.values[key]
    const isEditing = editing?.key === key
    const valueText = display(field, value, vars)
    const numeric = typeof value === 'number' ? value : Number(value)
    const max = field.type === 'meter' ? maxOf(field, vars) : null
    const min = field.min ?? 0
    const ratio =
      field.type === 'meter' && max !== null && Number.isFinite(numeric) && max > min
        ? Math.max(0, Math.min(1, (numeric - min) / (max - min)))
        : null
    const stage = field.stages && Number.isFinite(numeric) ? stageOf(field, numeric) : null

    return (
      <div key={key} className="relative">
        <div className="flex items-baseline gap-2 text-[12px]">
          <span className="min-w-0 flex-1 truncate opacity-75" title={key}>
            {label}
          </span>
          {isEditing ? (
            <input
              aria-label={t('修改 {name}', { name: label })}
              className="w-24 rounded bg-white/15 px-1.5 py-0.5 text-right text-[12px] outline-none focus:ring-1 focus:ring-violet-300"
              value={editing.text}
              onChange={(e) => setEditing({ key, text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
                if (e.key === 'Escape') setEditing(null)
                e.stopPropagation()
              }}
              onBlur={() => setEditing(null)}
              // biome-ignore lint/a11y/noAutofocus: 点了值就该直接能改
              autoFocus
            />
          ) : (
            <button
              type="button"
              disabled={!onEdit}
              title={onEdit ? t('点击修改') : undefined}
              onClick={() =>
                setEditing({
                  key,
                  text: Array.isArray(value) ? value.map(String).join(t('、')) : value == null ? '' : String(value),
                })
              }
              className="max-w-[60%] truncate text-right font-medium tabular-nums enabled:hover:text-violet-200 disabled:cursor-default"
            >
              {stage ? `${stage} · ${valueText}` : field.type === 'list' ? '' : valueText}
            </button>
          )}
          {delta !== undefined && (
            <span
              aria-live="polite"
              className={cx(
                'vn-delta pointer-events-none absolute -top-1 right-0 text-[12px] font-bold',
                delta > 0 ? 'text-emerald-300' : 'text-rose-300',
              )}
            >
              {delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`}
            </span>
          )}
        </div>
        {ratio !== null && (
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/15">
            <div
              className={cx(
                'h-full rounded-full transition-[width] duration-700',
                COLORS[field.color ?? ''] ?? 'bg-violet-400',
              )}
              style={{ width: `${ratio * 100}%` }}
            />
          </div>
        )}
        {field.type === 'list' && !isEditing && Array.isArray(value) && value.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {value.map((item, i) => (
              // 列表项可能重复（「火把」「火把」），下标做 key
              <span key={i} className="rounded bg-white/12 px-1.5 py-0.5 text-[11px]">
                {String(item)}
              </span>
            ))}
          </div>
        )}
      </div>
    )
  }

  // 手机 / 顶部一行：一行摘要，点开在下面展开全部
  if (bar) {
    return (
      <div className="pointer-events-auto relative z-20 px-3">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="vn-chip flex w-full items-center gap-3 overflow-hidden rounded-full px-3 py-1 text-left text-[12px]"
        >
          <span className="flex min-w-0 flex-1 gap-3 overflow-hidden whitespace-nowrap">
            {(pinned.length ? pinned : keys.slice(0, 3)).map((key) => {
              const field = schema[key] as StateField
              const delta = deltas?.values[key]
              return (
                <span key={key} className="shrink-0">
                  <span className="opacity-70">{field.label || key}</span>{' '}
                  <b className="tabular-nums">{display(field, vars[key], vars)}</b>
                  {delta !== undefined && (
                    <span className={cx('vn-delta ml-1 font-bold', delta > 0 ? 'text-emerald-300' : 'text-rose-300')}>
                      {delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`}
                    </span>
                  )}
                </span>
              )
            })}
          </span>
          <ChevronDownIcon className={cx('size-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
        </button>
        {open && <div className="vn-hud mt-1.5 space-y-2 rounded-2xl p-3">{keys.map(row)}</div>}
      </div>
    )
  }

  return (
    <div
      className={cx(
        'vn-hud pointer-events-auto absolute top-14 z-20 w-56 space-y-2 rounded-2xl p-3',
        position === 'top-left' ? 'left-3' : 'right-3',
      )}
    >
      {shown.map(row)}
      {keys.length > shown.length || open ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex w-full items-center justify-center gap-1 pt-0.5 text-[11px] opacity-60 hover:opacity-100"
        >
          {open ? t('收起') : t('全部状态（{count}）', { count: keys.length })}
          <ChevronDownIcon className={cx('size-3 transition-transform', open && 'rotate-180')} />
        </button>
      ) : null}
    </div>
  )
}
