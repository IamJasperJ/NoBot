import { useState } from 'react'
import { PlusIcon, TrashIcon } from './icons'
import { Button, cx, IconButton, inputClass } from './ui'

/**
 * 额外请求头编辑器：一行一个「名称 = 值」。
 * 编辑时允许暂时的空行，向外只输出名称不为空的项（Record<string, string>）
 */
export function HeadersEditor({
  value,
  onChange,
  disabled,
}: {
  value: Record<string, string>
  onChange: (value: Record<string, string>) => void
  disabled?: boolean
}) {
  const [rows, setRows] = useState<[string, string][]>(() => Object.entries(value))
  const emit = (next: [string, string][]) => {
    setRows(next)
    onChange(Object.fromEntries(next.filter(([name]) => name.trim()).map(([name, v]) => [name.trim(), v])))
  }
  return (
    <div className="space-y-2">
      {rows.map(([name, v], index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 请求头按位置编辑
        <div key={index} className="flex items-center gap-1.5">
          <input
            aria-label="请求头名称"
            placeholder="名称，如 X-Api-Key"
            className={cx(inputClass, 'h-8 w-[42%] shrink-0 px-2 py-0 font-mono text-xs')}
            value={name}
            disabled={disabled}
            onChange={(e) => emit(rows.map((row, i) => (i === index ? [e.target.value, row[1]] : row)))}
          />
          <input
            aria-label="请求头的值"
            placeholder="值"
            className={cx(inputClass, 'h-8 min-w-0 flex-1 px-2 py-0 font-mono text-xs')}
            value={v}
            disabled={disabled}
            onChange={(e) => emit(rows.map((row, i) => (i === index ? [row[0], e.target.value] : row)))}
          />
          <IconButton
            variant="danger"
            label="删除这个请求头"
            disabled={disabled}
            onClick={() => emit(rows.filter((_, i) => i !== index))}
          >
            <TrashIcon />
          </IconButton>
        </div>
      ))}
      <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setRows([...rows, ['', '']])}>
        <PlusIcon />
        添加请求头
      </Button>
    </div>
  )
}
