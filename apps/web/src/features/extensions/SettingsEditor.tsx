import type { ExtensionSettingField } from '@ai-parter/shared'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Combobox, type Option } from '../../components/combobox'
import { NumberField, SelectField, SwitchField, TextAreaField, TextField } from '../../components/form'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  PlusIcon,
  RefreshIcon,
  TrashIcon,
} from '../../components/icons'
import { Button, cx, IconButton } from '../../components/ui'
import { useExtensionsRuntime } from '../../extensions/runtime'
import { Slot } from '../../extensions/Slot'
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

type EditorProps = {
  fields: ExtensionSettingField[]
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
  disabled: boolean
  extensionId: string
  settings?: Record<string, unknown>
}

/** visibleWhen：单个条件，或数组（全部满足才显示） */
function visible(field: ExtensionSettingField, values: Record<string, unknown>): boolean {
  const conditions = field.visibleWhen === undefined ? [] : [field.visibleWhen].flat()
  return conditions.every((condition) =>
    [condition.equals].flat().some((expected) => values[condition.key] === expected),
  )
}

/** 设置项的说明：只用扩展自己写的说明（正则替换扩展有内置说明），不再自动生成「填写某某的文字」这类废话 */
function hintOf(field: ExtensionSettingField, extensionId: string): string | undefined {
  return field.hint || (extensionId === 'regex' ? regexHints[field.key] : undefined) || undefined
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
      onSettingsChange={onChange}
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
    <div className="min-w-0 space-y-3">
      {headingCount >= 3 && (
        <div className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            aria-label="切换全部分组"
            onClick={() =>
              changeCollapsed({
                ...collapsed,
                ...Object.fromEntries(groups.flatMap(({ heading }) => (heading ? [[heading.key, !allCollapsed]] : []))),
              })
            }
          >
            <ChevronDownIcon className={allCollapsed ? '' : 'rotate-180'} />
            {allCollapsed ? '全部展开' : '全部收起'}
          </Button>
        </div>
      )}
      {groups.map(({ heading, fields: members }, index) => {
        const shown = members.filter((field) => isVisible(field))
        if (!shown.length || (heading && !visible(heading, values))) return null
        const body = layoutRows(
          shown.filter((field) => !field.attachTo),
          renderField,
        )
        if (!heading)
          return (
            <div key={index} className="min-w-0 space-y-5">
              {body}
            </div>
          )
        const closed = collapsed[heading.key] ?? heading.defaultCollapsed ?? false
        return (
          <section
            key={heading.key}
            className="min-w-0 rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40"
          >
            <button
              type="button"
              aria-expanded={!closed}
              className={cx(
                'flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/40',
                closed ? 'rounded-xl' : 'rounded-t-xl',
              )}
              onClick={() => changeCollapsed({ ...collapsed, [heading.key]: !closed })}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{heading.label}</span>
                {heading.hint && <span className="mt-0.5 block text-xs text-zinc-500">{heading.hint}</span>}
              </span>
              {closed && <span className="shrink-0 text-xs text-zinc-400 tabular-nums">{shown.length} 项</span>}
              <ChevronRightIcon
                className={cx('size-4 shrink-0 text-zinc-400 transition-transform', !closed && 'rotate-90')}
              />
            </button>
            {!closed && (
              <div className="min-w-0 space-y-5 border-t border-zinc-100 px-4 py-4 dark:border-zinc-800">{body}</div>
            )}
          </section>
        )
      })}
    </div>
  )
}

/** type 为 custom 的字段：交给扩展前端注册的控件渲染 */
function CustomField({
  field,
  value,
  onChange,
  settings,
  onSettingsChange,
  disabled,
  extensionId,
  hint,
}: {
  field: ExtensionSettingField
  value: unknown
  onChange: (value: unknown) => void
  settings: Record<string, unknown>
  onSettingsChange: (settings: Record<string, unknown>) => void
  disabled: boolean
  extensionId: string
  hint: string | undefined
}) {
  const registered = useExtensionsRuntime((s) =>
    s.slots.some(
      (entry) =>
        entry.slot === 'extensions.settings.field' && entry.extensionId === extensionId && entry.id === field.key,
    ),
  )
  return (
    <div className="min-w-0 space-y-1.5">
      {registered ? (
        <Slot
          name="extensions.settings.field"
          props={{
            extensionId,
            fieldKey: field.key,
            label: field.label,
            value,
            onChange,
            settings,
            onSettingsChange,
            disabled,
          }}
        />
      ) : (
        <p className="text-xs text-zinc-400">「{field.label}」需要扩展的前端部分来显示（扩展前端未加载）</p>
      )}
      {hint && <p className="text-xs leading-relaxed text-zinc-500">{hint}</p>}
    </div>
  )
}

/** 连续的半宽字段两两并排（窄屏一列），其余字段各占一行 */
function layoutRows(fields: ExtensionSettingField[], render: (field: ExtensionSettingField) => ReactNode): ReactNode[] {
  const rows: ReactNode[] = []
  let halves: ExtensionSettingField[] = []
  const flush = () => {
    if (!halves.length) return
    rows.push(
      <div key={`row:${halves[0]?.key}`} className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
        {halves.map(render)}
      </div>,
    )
    halves = []
  }
  for (const field of fields) {
    if (field.width === 'half') halves.push(field)
    else {
      flush()
      rows.push(render(field))
    }
  }
  flush()
  return rows
}

/** 附着字段：在目标输入框右侧显示一个和输入框同高的按钮，点开弹出小窗编辑 */
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
  const place = () => {
    const rect = button.current?.getBoundingClientRect()
    // 浮层右边和按钮右边对齐（按钮在行尾），超出屏幕时往里收
    return rect
      ? { left: Math.max(8, Math.min(rect.right - 380, window.innerWidth - 388)), top: rect.bottom + 6 }
      : null
  }
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
    const reposition = () => setPosition(place())
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
    (typeof value === 'string' && value.trim().length > 0) ||
    (Array.isArray(value) && value.length > 0) ||
    value === true
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
        className={cx(
          'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium whitespace-nowrap shadow-xs transition-colors disabled:opacity-50',
          filled
            ? 'border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100 dark:border-violet-800 dark:bg-violet-950/60 dark:text-violet-300'
            : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300',
        )}
        onClick={() => setPosition(position ? null : place())}
      >
        {filled && <span aria-hidden="true" className="size-1.5 rounded-full bg-violet-500" />}
        {field.attachLabel ?? field.label}
      </button>
      {position &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="dialog"
            aria-label={field.label}
            style={{ left: position.left, top: position.top, maxHeight: `calc(100dvh - ${position.top + 8}px)` }}
            className="fixed z-50 w-[380px] max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  )
}

/** 控件右侧的按钮组（附着按钮、显示密码、拉取），和 36px 的输入框底边对齐 */
function Trailing({ children }: { children: ReactNode }) {
  return <div className="flex shrink-0 items-center gap-2">{children}</div>
}

function SecretToggle({ shown, onToggle, disabled }: { shown: boolean; onToggle: () => void; disabled: boolean }) {
  return (
    <IconButton
      variant="outline"
      label={shown ? '隐藏' : '显示'}
      aria-pressed={shown}
      disabled={disabled}
      onClick={onToggle}
    >
      {shown ? <EyeOffIcon /> : <EyeIcon />}
    </IconButton>
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
  onSettingsChange,
}: {
  field: ExtensionSettingField
  value: unknown
  onChange: (value: unknown) => void
  disabled: boolean
  extensionId: string
  settings: Record<string, unknown>
  attachments: ReactNode
  onSettingsChange: (settings: Record<string, unknown>) => void
}) {
  const [shown, setShown] = useState(false)
  const hint = hintOf(field, extensionId)
  if (field.type === 'custom') {
    return (
      <CustomField
        field={field}
        value={value}
        onChange={setValue}
        settings={settings}
        onSettingsChange={onSettingsChange}
        disabled={disabled}
        extensionId={extensionId}
        hint={hint}
      />
    )
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
        hint={hint}
        attachments={attachments}
      />
    )
  }
  if (field.type === 'string' || field.type === 'select') {
    const hasTrailing = !!attachments || (field.type === 'string' && field.secret)
    return (
      <div className="min-w-0 space-y-1.5">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            {field.type === 'string' ? (
              <TextField
                label={field.label}
                disabled={disabled}
                type={field.secret && !shown ? 'password' : 'text'}
                {...(field.placeholder === undefined ? {} : { placeholder: field.placeholder })}
                value={typeof value === 'string' ? value : ''}
                onChange={setValue}
              />
            ) : (
              <SelectField
                label={field.label}
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
          {hasTrailing && (
            <Trailing>
              {field.type === 'string' && field.secret && (
                <SecretToggle shown={shown} disabled={disabled} onToggle={() => setShown(!shown)} />
              )}
              {attachments}
            </Trailing>
          )}
        </div>
        {hint && <p className="text-xs leading-relaxed text-zinc-500">{hint}</p>}
      </div>
    )
  }
  const control = (() => {
    switch (field.type) {
      case 'boolean':
        return (
          <SwitchField
            label={field.label}
            {...(hint ? { hint } : {})}
            disabled={disabled}
            checked={typeof value === 'boolean' ? value : false}
            onChange={setValue}
          />
        )
      case 'textarea':
        return (
          <TextAreaField
            {...(field.rows === undefined ? {} : { rows: field.rows })}
            {...(field.placeholder === undefined ? {} : { placeholder: field.placeholder })}
            label={field.label}
            {...(hint ? { hint } : {})}
            disabled={disabled}
            mono={/json|workflow|工作流/i.test(`${field.key}${field.label}`)}
            value={typeof value === 'string' ? value : ''}
            onChange={setValue}
          />
        )
      case 'number':
        return (
          <NumberField
            label={field.label}
            {...(hint ? { hint } : {})}
            disabled={disabled}
            value={typeof value === 'number' && Number.isFinite(value) ? value : 0}
            min={field.min ?? -1e9}
            max={field.max ?? 1e9}
            slider={!!field.slider && field.min !== undefined && field.max !== undefined}
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
            hint={hint}
          />
        )
      case 'heading':
        return null
    }
  })()
  if (!attachments) return <div className="min-w-0">{control}</div>
  return (
    <div className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">{control}</div>
      <div className={cx('shrink-0', field.type === 'textarea' && 'mt-[26px]')}>
        <Trailing>{attachments}</Trailing>
      </div>
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
  hint: string | undefined
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
  const add = () => {
    focusIndex.current = items.length
    setExpanded([...items.map((_, i) => !!expanded[i]), true])
    onChange([...items, defaults(field.itemFields)])
  }
  return (
    <div ref={root} className="min-w-0 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-zinc-800 dark:text-zinc-200">{field.label}</span>
        {items.length > 0 && <span className="text-xs text-zinc-400 tabular-nums">{items.length}</span>}
        {items.length >= 2 && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto -my-1 h-7 px-2 text-xs"
            aria-label={`切换全部${field.label}`}
            onClick={() => setExpanded(items.map(() => !allExpanded))}
          >
            {allExpanded ? '全部收起' : '全部展开'}
          </Button>
        )}
      </div>
      {hint && <p className="text-xs leading-relaxed text-zinc-500">{hint}</p>}
      <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
        {items.map((item, index) => {
          const rawTitle = titleField ? recordOf(item)[titleField.key] : ''
          const title =
            titleField?.type === 'select'
              ? (titleField.options.find((option) => option.value === rawTitle)?.label ?? rawTitle)
              : rawTitle
          const open = !!expanded[index]
          return (
            // 无 id 的设置列表以位置为键，移动和删除时同步调整展开状态。
            <div
              key={index}
              data-settings-item={index}
              className="min-w-0 border-b border-zinc-100 last:border-b-0 dark:border-zinc-800"
            >
              <div
                className={cx(
                  'group flex h-10 items-center gap-1 pr-1.5 pl-2',
                  open ? 'bg-zinc-50 dark:bg-zinc-800/40' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/30',
                )}
              >
                <button
                  type="button"
                  aria-expanded={open}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 text-left text-sm"
                  onClick={() => setExpanded(items.map((_, i) => (i === index ? !expanded[i] : !!expanded[i])))}
                >
                  <ChevronRightIcon
                    className={cx('size-4 shrink-0 text-zinc-400 transition-transform', open && 'rotate-90')}
                  />
                  <span
                    className={cx(
                      'truncate',
                      typeof title === 'string' && title.trim() ? 'font-medium' : 'text-zinc-400 italic',
                    )}
                  >
                    {typeof title === 'string' && title.trim() ? title : '（未命名）'}
                  </span>
                </button>
                <div className="flex shrink-0 items-center opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <IconButton label="上移" disabled={disabled || index === 0} onClick={() => move(index, -1)}>
                    <ArrowUpIcon />
                  </IconButton>
                  <IconButton
                    label="下移"
                    disabled={disabled || index === items.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDownIcon />
                  </IconButton>
                  <IconButton
                    variant="danger"
                    label={`删除${field.label}第 ${index + 1} 项`}
                    disabled={disabled}
                    onClick={() => {
                      if (confirm(`确定删除「${field.label}」的第 ${index + 1} 项及其全部设置吗？保存后生效。`)) {
                        setExpanded(items.flatMap((_, i) => (i === index ? [] : [!!expanded[i]])))
                        onChange(items.filter((_, i) => i !== index))
                      }
                    }}
                  >
                    <TrashIcon />
                  </IconButton>
                </div>
              </div>
              {open && (
                <div className="border-t border-zinc-100 px-4 py-4 dark:border-zinc-800">
                  <SettingsEditor
                    fields={field.itemFields}
                    values={recordOf(item)}
                    extensionId={extensionId}
                    disabled={disabled}
                    settings={settings}
                    onChange={(next) => onChange(items.map((old, i) => (i === index ? next : old)))}
                  />
                </div>
              )}
            </div>
          )
        })}
        <button
          type="button"
          disabled={disabled}
          aria-label="添加一项"
          onClick={add}
          className={cx(
            'flex h-10 w-full items-center gap-2 px-3 text-sm text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-violet-600 disabled:opacity-50 dark:hover:bg-zinc-800/40',
            items.length > 0 && 'border-t border-zinc-100 dark:border-zinc-800',
          )}
        >
          <PlusIcon className="size-4" />
          {items.length === 0 ? `还没有${field.label}，点这里添加` : '添加一项'}
        </button>
      </div>
    </div>
  )
}

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
  hint: string | undefined
  attachments: ReactNode
}) {
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
      // 草稿放在请求体里（可能含整份工作流 JSON，放进网址会超长）；候选列表跟随当前会话的连接
      const chatId = useUi.getState().chatId
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: current.current, ...(chatId ? { chatId } : {}) }),
        signal: request.signal,
      })
      const raw = await response.text()
      let data: unknown = null
      try {
        data = raw ? JSON.parse(raw) : null
      } catch {
        throw new Error(`拉取候选失败（HTTP ${response.status}，返回的不是 JSON）`)
      }
      if (data === null) throw new Error(`拉取候选失败（HTTP ${response.status}，没有返回内容）`)
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
      if (!request.signal.aborted) {
        setOptions(fetched)
        if (manual) toast.info(`已拉取 ${fetched.length} 个候选`)
      }
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
  if (field.type === 'select' && value && !choices.some((option) => option.value === value))
    choices.push({ value, label: `${value}（自定义）` })
  const labelId = useId()
  return (
    <div className="min-w-0 space-y-1.5">
      {field.type === 'string' && (
        <span id={labelId} className="block text-[13px] font-medium text-zinc-800 dark:text-zinc-200">
          {field.label}
        </span>
      )}
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
            <Combobox
              label={field.label}
              value={value}
              onChange={onChange}
              options={choices}
              disabled={disabled}
              placeholder={field.placeholder ?? (choices.length ? '选择或直接输入' : '直接输入，或点右侧按钮拉取')}
              secret={!!field.secret && !shown}
            />
          )}
        </div>
        <Trailing>
          {field.type === 'string' && field.secret && (
            <SecretToggle shown={shown} disabled={disabled} onToggle={() => setShown(!shown)} />
          )}
          {attachments}
          <IconButton
            variant="outline"
            disabled={disabled || loading}
            onClick={() => void load(true)}
            label={`拉取${field.label}`}
          >
            <RefreshIcon className={loading ? 'animate-spin' : ''} />
          </IconButton>
        </Trailing>
      </div>
      {error ? (
        // 自动拉取失败时多个字段会同时报同一个错，这里只给一行简短提示，完整原因悬停可见（手动拉取会弹出完整错误）
        <p className="truncate text-xs text-amber-600 dark:text-amber-400" title={error}>
          未能拉取候选，可直接手填或点右侧按钮重试
        </p>
      ) : (
        hint && <p className="text-xs leading-relaxed text-zinc-500">{hint}</p>
      )}
    </div>
  )
}
