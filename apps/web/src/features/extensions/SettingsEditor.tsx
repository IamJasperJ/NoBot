import type { ExtensionSettingField } from '@ai-parter/shared'
import { NumberField, SelectField, SwitchField, TextAreaField, TextField } from '../../components/form'
import { ChevronLeftIcon, ChevronRightIcon } from '../../components/icons'
import { Button, IconButton } from '../../components/ui'

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function defaults(fields: ExtensionSettingField[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((field) => [
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

export function SettingsEditor({
  fields,
  values,
  onChange,
  disabled,
  extensionId,
}: {
  fields: ExtensionSettingField[]
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
  disabled: boolean
  extensionId: string
}) {
  return (
    <div className="min-w-0 space-y-4">
      {fields.map((field) => {
        const value = values[field.key]
        const setValue = (next: unknown) => onChange({ ...values, [field.key]: next })
        const props = {
          label: field.label,
          hint: field.hint || (extensionId === 'regex' ? regexHints[field.key] : undefined) || fallbackHint(field),
          disabled,
        }
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
          case 'string':
            return (
              <TextField
                key={field.key}
                {...props}
                value={typeof value === 'string' ? value : ''}
                onChange={setValue}
              />
            )
          case 'textarea':
            return (
              <TextAreaField
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
                step={0.01}
                onChange={setValue}
              />
            )
          case 'select':
            return (
              <SelectField
                key={field.key}
                {...props}
                value={typeof value === 'string' ? value : ''}
                options={[{ value: '', label: '请选择' }, ...field.options.filter((option) => option.value !== '')]}
                onChange={setValue}
              />
            )
          case 'list': {
            const items: unknown[] = Array.isArray(value) ? value : []
            function move(index: number, offset: number) {
              const next = [...items]
              const target = index + offset
              if (target < 0 || target >= next.length) return
              ;[next[index], next[target]] = [next[target], next[index]]
              setValue(next)
            }
            return (
              <div key={field.key} className="min-w-0 space-y-3">
                <div>
                  <h3 className="text-sm font-medium">{props.label}</h3>
                  <p className="text-xs text-zinc-500">{props.hint}</p>
                </div>
                {items.map((item, index) => (
                  // 列表项由 schema 定义，可能没有 id；控件完全受控，顺序变动不会保留旧值。
                  <div
                    key={index}
                    className="min-w-0 space-y-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs text-zinc-500">第 {index + 1} 项</span>
                      <div className="ml-auto flex gap-1">
                        <IconButton
                          label="上移"
                          className="shrink-0"
                          disabled={disabled || index === 0}
                          onClick={() => move(index, -1)}
                        >
                          <ChevronLeftIcon className="rotate-90" />
                        </IconButton>
                        <IconButton
                          label="下移"
                          className="shrink-0"
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
                            if (confirm(`确定删除「${field.label}」的第 ${index + 1} 项及其全部设置吗？保存后生效。`))
                              setValue(items.filter((_, i) => i !== index))
                          }}
                        >
                          删除
                        </Button>
                      </div>
                    </div>
                    <SettingsEditor
                      fields={field.itemFields}
                      values={recordOf(item)}
                      extensionId={extensionId}
                      disabled={disabled}
                      onChange={(next) => setValue(items.map((old, i) => (i === index ? next : old)))}
                    />
                  </div>
                ))}
                {items.length === 0 && <p className="text-sm text-zinc-500">暂无项目，点击下方按钮添加。</p>}
                <Button disabled={disabled} onClick={() => setValue([...items, defaults(field.itemFields)])}>
                  添加一项
                </Button>
              </div>
            )
          }
        }
        return null
      })}
    </div>
  )
}
