import { type ComponentProps, useRef, useState } from 'react'
import { TextAreaField, TextField } from '../../components/form'
import { Avatar, Button } from '../../components/ui'
import { errorMessage, toast } from '../../stores/toast'

export function CountedText(props: ComponentProps<typeof TextField>) {
  return <TextField {...props} />
}

export function CountedArea(props: ComponentProps<typeof TextAreaField>) {
  return (
    <div>
      <TextAreaField {...props} />
      <p className="mt-1 text-xs text-zinc-500">估算字数：{props.value.length}</p>
    </div>
  )
}

export function AvatarUpload({
  name,
  url,
  disabled,
  onUpload,
}: {
  name: string
  url: string | null
  disabled: boolean
  onUpload: (file: File) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        aria-label="上传头像"
        title="点击更换头像"
        className="group relative shrink-0 rounded-full ring-1 ring-black/5 disabled:opacity-60 dark:ring-white/10"
      >
        <Avatar name={name} url={url} size={64} />
        <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-xs font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
          更换
        </span>
      </button>
      <div className="min-w-0 space-y-1">
        <Button size="sm" disabled={disabled} onClick={() => input.current?.click()}>
          上传头像
        </Button>
        <p className="text-xs text-zinc-500">支持任意图片格式，上传后立即生效</p>
      </div>
      <input
        ref={input}
        hidden
        type="file"
        accept="image/*"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) onUpload(file)
        }}
      />
    </div>
  )
}

/** 同一编辑器内串行提交，错误统一展示，避免重复点击造成重复创建。 */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const run = async (action: () => Promise<void>) => {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    try {
      await action()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  return { busy, run }
}

export function moveItem<T>(items: T[], index: number, offset: number): T[] {
  const result = [...items]
  const target = index + offset
  if (index < 0 || target < 0 || target >= items.length) return result
  const item = result.splice(index, 1)[0]
  if (item !== undefined) result.splice(target, 0, item)
  return result
}
