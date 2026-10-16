import type { ExtensionSettingField } from '@ai-parter/shared'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NumberField, SelectField, SwitchField, TextAreaField, TextField } from '../../components/form'
import { ChevronLeftIcon, ChevronRightIcon, RefreshIcon } from '../../components/icons'
import { Button, IconButton, inputClass } from '../../components/ui'

import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function defaults(fields: ExtensionSettingField[]): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter((field) => field.type !== 'heading')
      .map((field) => [
        field.key,
        field.type === 'boolean' ? false : field.type === 'number' ? 0 : field.type === 'list' ? [] : '',
      ]),
  )
}

const regexHints: Record<string, string> = {
  name: '给规则起一个容易辨认的名称，便于以后查找。',
  find: '填写要查找的文字，或使用 /正则表达式/标志（例如 /星号/g）。',
  replace: '填写替换后的文字；留空可删除匹配内容，正则分组可用 $1 引用。',
  input: '在用户消息保存前执行替换，会改变保存的用户消息。',
  output: '在 AI 回复保存前执行替换，会改变保存的回复。',
  prompt: '在发送给模型前替换用户和助手消息，不改变聊天记录。',
  enabled: '开启后执行这条规则，关闭可保留规则而暂停执行。',
}

function fallbackHint(field: ExtensionSettingField): string {
  switch (field.type) {
    case 'heading':
      return ''
    case 'boolean':
      return `开启或关闭「${field.label}」功能。`
    case 'string':
      return `填写「${field.label}」使用的文字。`
    case 'textarea':
      return `填写「${field.label}」的内容，支持多行文字。`
    case 'number':
      return `设置「${field.label}」的数值${field.min !== undefined || field.max !== undefined ? `，范围为 ${field.min ?? -1e9} 至 ${field.max ?? 1e9}` : ''}。`
    case 'select':
      return `选择「${field.label}」使用的选项。`
    case 'list':
      return '逐项填写设置，可添加、删除或调整顺序；保存后生效。'
  }
}

type EditorProps = {
  fields: ExtensionSettingField[]
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
  disabled: boolean
  extensionId: string
  settings?: Record<string, unknown>
}

function visible(field: ExtensionSettingField, values: Record<string, unknown>): boolean {
  const condition = field.visibleWhen
  return (
    !condition ||
    (Array.isArray(condition.equals) ? condition.equals : [condition.equals]).some(
      (expected) => values[condition.key] === expected,
    )
  )
}

export function SettingsEditor(props: EditorProps) {
  // 切换扩展时重建临时状态，列表展开状态不写入设置。
  return <SettingsForm key={props.extensionId} {...props} />
}

function SettingsForm({ fields, values, onChange, disabled, extensionId, settings = values }: EditorProps) {
  const storageKey = `ext-settings-collapsed:${extensionId}`
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      const stored = recordOf(JSON.parse(localStorage.getItem(storageKey) ?? '{}'))
      return Object.fromEntries(Object.entries(stored).filter(([, value]) => typeof value === 'boolean')) as Record<
        string,
        boolean
      >
    } catch {
      return {}
    }
  })
  const groups: { heading?: Extract<ExtensionSettingField, { type: 'heading' }>; fields: ExtensionSettingField[] }[] = [
    { fields: [] },
  ]
  for (const field of fields) {
    if (field.type === 'heading') groups.push({ heading: field, fields: [] })
    else groups[groups.length - 1]?.fields.push(field)
  }
  const isVisible = (field: ExtensionSettingField, visited = new Set<string>()): boolean => {
    if (!visible(field, values) || visited.has(field.key)) return false
    if (!field.attachTo) return true
    visited.add(field.key)
    const target = fields.find((candidate) => candidate.key === field.attachTo)
    return !!target && isVisible(target, visited)
  }
  const changeCollapsed = (next: Record<string, boolean>) => {
    setCollapsed(next)
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      // 隐私模式或存储额度不足时仍允许本次操作。
    }
  }
  const headingCount = groups.filter((group) => group.heading).length
  const allCollapsed = groups.every(
    ({ heading }) => !heading || (collapsed[heading.key] ?? heading.defaultCollapsed ?? false),
  )
  const renderField = (field: ExtensionSettingField): ReactNode => (
    <SettingControl
      key={field.key}
      field={field}
      value={values[field.key]}
      onChange={(next) => onChange({ ...values, [field.key]: next })}
      disabled={disabled}
      extensionId={extensionId}
      settings={settings}
      attachments={fields
        .filter((candidate) => candidate.attachTo === field.key && isVisible(candidate))
        .map((attached) => (
          <AttachedField key={attached.key} field={attached} value={values[attached.key]} disabled={disabled}>
            {renderField(attached)}
          </AttachedField>
        ))}
    />
  )
  return (
    <div className="min-w-0 space-y-4">
      {headingCount >= 3 && (
        <Button
          aria-label="切换全部分组"
          onClick={() =>
            changeCollapsed({
              ...collapsed,
              ...Object.fromEntries(groups.flatMap(({ heading }) => (heading ? [[heading.key, !allCollapsed]] : []))),
            })
          }
        >
          {allCollapsed ? '全部展开' : '全部收起'}
        </Button>
      )}
      {groups.map(({ heading, fields: members }, index) => {
        const shown = members.filter((field) => isVisible(field))
        if (!shown.length || (heading && !visible(heading, values))) return null
        const closed = heading ? (collapsed[heading.key] ?? heading.defaultCollapsed ?? false) : false
        return (
          <div key={heading?.key ?? index} className="min-w-0 space-y-4">
            {heading && (
              <button
                type="button"
                aria-expanded={!closed}
                className="flex w-full items-center gap-2 text-left"
                onClick={() => changeCollapsed({ ...collapsed, [heading.key]: !closed })}
              >
                <ChevronRightIcon className={`shrink-0 ${closed ? '' : 'rotate-90'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-bold">{heading.label}</span>
                  {heading.hint && <span className="block text-xs text-zinc-500">{heading.hint}</span>}
                </span>
                {closed && <span className="shrink-0 text-xs text-zinc-500">{shown.length} 项</span>}
              </button>
            )}
            {!closed && shown.filter((field) => !field.attachTo).map(renderField)}
          </div>
        )
      })}
    </div>
  )
}

function AttachedField({
  field,
  value,
  disabled,
  children,
}: {
  field: ExtensionSettingField
  value: unknown
  disabled: boolean
  children: ReactNode
}) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    if (!position) return
    const closeOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !button.current?.contains(event.target)
      )
        setPosition(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setPosition(null)
        button.current?.focus()
      }
    }
    const reposition = () => {
      const rect = button.current?.getBoundingClientRect()
      if (rect) setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 368)), top: rect.bottom + 4 })
    }
    panel.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus()
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape, true)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape, true)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [position !== null])
  const filled =
    (typeof value === 'string' && value.length > 0) || (Array.isArray(value) && value.length > 0) || value === true
  return (
    <>
      <button
        ref={button}
        type="button"
        title={field.label}
        aria-label={field.label}
        aria-expanded={!!position}
        aria-controls={position ? id : undefined}
        aria-haspopup="dialog"
        disabled={disabled}
        className={`size-[38px] shrink-0 rounded-lg text-sm font-medium disabled:opacity-50 ${filled ? 'bg-violet-600 text-white' : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'}`}
        onClick={() => {
          const rect = button.current?.getBoundingClientRect()
          if (rect)
            setPosition(
              position
                ? null
                : { left: Math.max(8, Math.min(rect.left, window.innerWidth - 368)), top: rect.bottom + 4 },
            )
        }}
      >
        {field.attachLabel ?? field.label.slice(0, 1)}
      </button>
      {position &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="dialog"
            aria-label={field.label}
            style={{ left: position.left, top: position.top, maxHeight: `calc(100dvh - ${position.top + 8}px)` }}
            className="fixed z-50 w-[360px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-lg border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  )
}

function SettingControl({
  field,
  value,
  onChange: setValue,
  disabled,
  extensionId,
  settings,
  attachments,
}: {
  field: ExtensionSettingField
  value: unknown
  onChange: (value: unknown) => void
  disabled: boolean
  extensionId: string
  settings: Record<string, unknown>
  attachments: ReactNode
}) {
  const [shown, setShown] = useState<Record<string, boolean>>({})
  const props = {
    label: field.label,
    hint: field.hint || (extensionId === 'regex' ? regexHints[field.key] : undefined) || fallbackHint(field),
    disabled,
  }
  if ((field.type === 'string' || field.type === 'select') && field.optionsSource) {
    return (
      <RemoteOptionsField
        field={field}
        value={typeof value === 'string' ? value : ''}
        onChange={setValue}
        disabled={disabled}
        extensionId={extensionId}
        settings={settings}
        hint={props.hint}
        attachments={attachments}
      />
    )
  }
  // 单行控件把说明放在下一行，保证附着按钮与输入框底边对齐。
  if (field.type === 'string' || field.type === 'select') {
    return (
      <div className="space-y-1">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            {field.type === 'string' ? (
              <TextField
                label={props.label}
                disabled={disabled}
                type={field.secret && !shown[field.key] ? 'password' : 'text'}
                {...(field.placeholder === undefined ? {} : { placeholder: field.placeholder })}
                value={typeof value === 'string' ? value : ''}
                onChange={setValue}
              />
            ) : (
              <SelectField
                label={props.label}
                disabled={disabled}
                value={typeof value === 'string' ? value : ''}
                options={
                  field.options.some((option) => option.value === '')
                    ? field.options
                    : [{ value: '', label: '请选择' }, ...field.options]
                }
                onChange={setValue}
              />
            )}
          </div>
          {attachments}
        </div>
        <p className="text-xs text-zinc-500">{props.hint}</p>
        {field.type === 'string' && field.secret && (
          <Button
            disabled={disabled}
            aria-pressed={!!shown[field.key]}
            onClick={() => setShown({ ...shown, [field.key]: !shown[field.key] })}
          >
            {shown[field.key] ? '隐藏' : '显示'}
          </Button>
        )}
      </div>
    )
  }
  const control = (() => {
    switch (field.type) {
      case 'boolean':
        return (
          <SwitchField
            key={field.key}
            {...props}
            checked={typeof value === 'boolean' ? value : false}
            onChange={setValue}
          />
        )
      case 'textarea':
        return (
          <TextAreaField
            {...(field.rows === undefined ? {} : { rows: field.rows })}
            {...(field.placeholder === undefined ? {} : { placeholder: field.placeholder })}
            key={field.key}
            {...props}
            value={typeof value === 'string' ? value : ''}
            onChange={setValue}
          />
        )
      case 'number':
        return (
          <NumberField
            key={field.key}
            {...props}
            value={typeof value === 'number' && Number.isFinite(value) ? value : 0}
            min={field.min ?? -1e9}
            max={field.max ?? 1e9}
            slider={false}
            step={field.step ?? 0.01}
            onChange={setValue}
          />
        )
      case 'list':
        return (
          <SettingsList
            field={field}
            value={value}
            onChange={setValue}
            disabled={disabled}
            extensionId={extensionId}
            settings={settings}
            hint={props.hint}
          />
        )
      case 'heading':
        return null
    }
  })()
  return (
    <div className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">{control}</div>
      <div className={`flex shrink-0 gap-2 ${field.type === 'textarea' ? 'mt-6' : ''}`}>{attachments}</div>
    </div>
  )
}

function SettingsList({
  field,
  value,
  onChange,
  disabled,
  extensionId,
  settings,
  hint,
}: {
  field: Extract<ExtensionSettingField, { type: 'list' }>
  value: unknown
  onChange: (value: unknown[]) => void
  disabled: boolean
  extensionId: string
  settings: Record<string, unknown>
  hint: string
}) {
  const items: unknown[] = Array.isArray(value) ? value : []
  const [expanded, setExpanded] = useState<boolean[]>([])
  const focusIndex = useRef<number | null>(null)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focusIndex.current === null) return
    root.current
      ?.querySelector<HTMLElement>(
        `[data-settings-item="${focusIndex.current}"] input, [data-settings-item="${focusIndex.current}"] textarea, [data-settings-item="${focusIndex.current}"] select`,
      )
      ?.focus()
    focusIndex.current = null
  })
  function move(index: number, offset: number) {
    const target = index + offset
    if (target < 0 || target >= items.length) return
    const next = [...items]
    ;[next[index], next[target]] = [next[target], next[index]]
    const nextExpanded = items.map((_, i) => !!expanded[i])
    ;[nextExpanded[index], nextExpanded[target]] = [nextExpanded[target] ?? false, nextExpanded[index] ?? false]
    setExpanded(nextExpanded)
    onChange(next)
  }
  const titleField =
    field.itemFields.find((child) => child.key === field.titleKey) ??
    field.itemFields.find((child) => child.type === 'string')
  const allExpanded = items.every((_, index) => expanded[index])
  return (
    <div ref={root} className="min-w-0 space-y-3">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">{field.label}</h3>
          {items.length >= 2 && (
            <Button aria-label={`切换全部${field.label}`} onClick={() => setExpanded(items.map(() => !allExpanded))}>
              {allExpanded ? '全部收起' : '全部展开'}
            </Button>
          )}
        </div>
        <p className="text-xs text-zinc-500">{hint}</p>
      </div>
      {items.map((item, index) => {
        const rawTitle = titleField ? recordOf(item)[titleField.key] : ''
        const title =
          titleField?.type === 'select'
            ? (titleField.options.find((option) => option.value === rawTitle)?.label ?? rawTitle)
            : rawTitle
        return (
          // 无 id 的设置列表以位置为键，移动和删除时同步调整展开状态。
          <div
            key={index}
            data-settings-item={index}
            className="min-w-0 space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-expanded={!!expanded[index]}
                className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
                onClick={() => setExpanded(items.map((_, i) => (i === index ? !expanded[i] : !!expanded[i])))}
              >
                <ChevronRightIcon className={`shrink-0 ${expanded[index] ? 'rotate-90' : ''}`} />
                <span className="truncate">{typeof title === 'string' && title.trim() ? title : '（未命名）'}</span>
              </button>
              <div className="ml-auto flex shrink-0 gap-1">
                <IconButton label="上移" disabled={disabled || index === 0} onClick={() => move(index, -1)}>
                  <ChevronLeftIcon className="rotate-90" />
                </IconButton>
                <IconButton
                  label="下移"
                  disabled={disabled || index === items.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ChevronRightIcon className="rotate-90" />
                </IconButton>
                <Button
                  variant="danger"
                  aria-label={`删除${field.label}第 ${index + 1} 项`}
                  disabled={disabled}
                  onClick={() => {
                    if (confirm(`确定删除「${field.label}」的第 ${index + 1} 项及其全部设置吗？保存后生效。`)) {
                      setExpanded(items.flatMap((_, i) => (i === index ? [] : [!!expanded[i]])))
                      onChange(items.filter((_, i) => i !== index))
                    }
                  }}
                >
                  删除
                </Button>
              </div>
            </div>
            {expanded[index] && (
              <SettingsEditor
                fields={field.itemFields}
                values={recordOf(item)}
                extensionId={extensionId}
                disabled={disabled}
                settings={settings}
                onChange={(next) => onChange(items.map((old, i) => (i === index ? next : old)))}
              />
            )}
          </div>
        )
      })}
      {items.length === 0 && <p className="text-sm text-zinc-500">暂无项目，点击下方按钮添加。</p>}
      <Button
        disabled={disabled}
        onClick={() => {
          focusIndex.current = items.length
          setExpanded([...items.map((_, i) => !!expanded[i]), true])
          onChange([...items, defaults(field.itemFields)])
        }}
      >
        添加一项
      </Button>
    </div>
  )
}

type Option = { value: string; label: string }

function RemoteOptionsField({
  field,
  value,
  onChange,
  disabled,
  extensionId,
  settings,
  hint,
  attachments,
}: {
  field: Extract<ExtensionSettingField, { type: 'string' | 'select' }>
  value: string
  onChange: (value: string) => void
  disabled: boolean
  extensionId: string
  settings: Record<string, unknown>
  hint: string
  attachments: ReactNode
}) {
  const listId = useId()
  const [options, setOptions] = useState<Option[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [shown, setShown] = useState(false)
  const current = useRef(settings)
  current.current = settings
  const controller = useRef<AbortController | null>(null)
  const load = async (manual: boolean) => {
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    setLoading(true)
    setError('')
    try {
      const path = field.optionsSource ?? ''
      const url = new URL(`/api/ext/${encodeURIComponent(extensionId)}/${path.replace(/^\/+/, '')}`, location.origin)
      if (!url.pathname.startsWith(`/api/ext/${encodeURIComponent(extensionId)}/`))
        throw new Error('候选接口路径不合法')
      url.searchParams.set('settings', JSON.stringify(current.current))
      // 候选列表跟随当前会话的连接，草稿设置仍只用于本次读取。
      const chatId = useUi.getState().chatId
      if (chatId) url.searchParams.set('chatId', chatId)
      const response = await fetch(url, { signal: request.signal })
      const data: unknown = await response.json()
      const body = recordOf(data)
      if (!response.ok || !Array.isArray(body.options)) {
        const detail = recordOf(body.error)
        throw new Error(
          typeof detail.message === 'string'
            ? detail.message
            : typeof body.error === 'string'
              ? body.error
              : '拉取候选失败',
        )
      }
      const fetched = body.options.map((option: unknown) => {
        const item = recordOf(option)
        if (typeof item.value !== 'string' || typeof item.label !== 'string') throw new Error('候选数据格式不正确')
        return { value: item.value, label: item.label }
      })
      if (!request.signal.aborted) setOptions(fetched)
    } catch (e) {
      if (!request.signal.aborted) {
        setError(errorMessage(e))
        if (manual) toast.error(errorMessage(e))
      }
    } finally {
      if (!request.signal.aborted) setLoading(false)
    }
  }
  // 表单展开时挂载；草稿变化不自动重拉，手动刷新始终使用最新完整设置。
  const loader = useRef(load)
  loader.current = load
  useEffect(() => {
    void loader.current(false)
    return () => controller.current?.abort()
  }, [])
  const choices = [
    ...new Map(
      [...(field.type === 'select' ? field.options : []), ...options].map((option) => [option.value, option]),
    ).values(),
  ]
  if (value && !choices.some((option) => option.value === value)) choices.push({ value, label: `${value}（自定义）` })
  return (
    <div className="space-y-1">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          {field.type === 'select' ? (
            <SelectField
              label={field.label}
              value={value}
              disabled={disabled}
              onChange={onChange}
              options={
                choices.some((option) => option.value === '') ? choices : [{ value: '', label: '请选择' }, ...choices]
              }
            />
          ) : (
            <label className="block space-y-1 text-sm font-medium text-zinc-700 dark:text-zinc-300">
              <span>{field.label}</span>
              <input
                className={inputClass}
                list={listId}
                type={field.secret && !shown ? 'password' : 'text'}
                placeholder={field.placeholder}
                value={value}
                disabled={disabled}
                onChange={(e) => onChange(e.target.value)}
              />
              <datalist id={listId}>
                {choices.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </datalist>
            </label>
          )}
        </div>
        {attachments}
        <Button disabled={disabled || loading} onClick={() => void load(true)} aria-label={`拉取${field.label}`}>
          <RefreshIcon className={loading ? 'animate-spin' : ''} />
          拉取
        </Button>
      </div>
      <p className="text-xs text-zinc-500">{hint}</p>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {field.type === 'string' && field.secret && (
        <Button disabled={disabled} aria-pressed={shown} onClick={() => setShown(!shown)}>
          {shown ? '隐藏' : '显示'}
        </Button>
      )}
    </div>
  )
}
