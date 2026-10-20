import type { CutoutMode } from '@nobot/shared'
import { useEffect, useState } from 'react'
import { useMattingStatus } from '../../api/matting'
import { Button, cx, Dialog } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'

/** 透明图下面垫的底：棋盘格看透明区域，深色和浅色底看白边、绿边这类残留 */
const backdrops = {
  checker:
    'bg-[length:16px_16px] bg-[linear-gradient(45deg,#0000000d_25%,transparent_25%,transparent_75%,#0000000d_75%),linear-gradient(45deg,#0000000d_25%,transparent_25%,transparent_75%,#0000000d_75%)] bg-[position:0_0,8px_8px] dark:bg-[linear-gradient(45deg,#ffffff0f_25%,transparent_25%,transparent_75%,#ffffff0f_75%),linear-gradient(45deg,#ffffff0f_25%,transparent_25%,transparent_75%,#ffffff0f_75%)]',
  dark: 'bg-zinc-800',
  light: 'bg-white',
} as const
type Backdrop = keyof typeof backdrops

/** 「本地模型」能不能选：模型和运行时都下载好才行 */
export function useModelReady() {
  const status = useMattingStatus(true)
  return status.data?.runtime.state === 'ready' && status.data.model.state === 'ready'
}

/** 抠图方式选择：两个分段按钮，本地模型没下载时禁用并提示 */
export function CutoutModePicker({
  value,
  onChange,
  disabled,
}: {
  value: CutoutMode
  onChange: (mode: CutoutMode) => void
  disabled?: boolean
}) {
  const modelReady = useModelReady()
  const options: { value: CutoutMode; label: string; off?: boolean }[] = [
    { value: 'algorithm', label: t('算法抠图') },
    { value: 'model', label: t('本地模型'), off: !modelReady },
  ]
  return (
    <div className="space-y-1">
      <div className="inline-flex rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-700">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            disabled={disabled || o.off}
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
            className={cx(
              'h-8 rounded-md px-3 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40',
              value === o.value
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
      {!modelReady && (
        <p className="text-xs text-zinc-500">{t('本地模型要先在「扩展 → 图片生成 → 立绘抠图」里下载。')}</p>
      )}
    </div>
  )
}

function Pane({
  label,
  src,
  backdrop,
  loading,
}: {
  label: string
  src: string | null
  backdrop: Backdrop
  loading?: boolean
}) {
  return (
    <figure className="min-w-0 space-y-1.5">
      <figcaption className="text-xs font-medium text-zinc-500">{label}</figcaption>
      <div
        className={cx(
          'relative flex aspect-[3/4] items-end justify-center overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800',
          backdrops[backdrop],
        )}
      >
        {src && <img src={src} alt={label} className="size-full object-contain object-bottom" />}
        {loading && (
          <span className="absolute inset-0 flex items-center justify-center bg-white/60 text-sm font-medium text-violet-700 dark:bg-zinc-950/60 dark:text-violet-300">
            <span className="animate-pulse">{t('正在抠图…')}</span>
          </span>
        )}
      </div>
    </figure>
  )
}

/**
 * 单张图重新抠图：左边现在的结果，右边按所选方式重抠的预览，满意再应用。
 * 预览由服务端算出来、不保存；应用时服务端会再算一遍并覆盖。
 */
export function CutoutDialog({
  open,
  title,
  current,
  hasOriginal,
  loadPreview,
  onApply,
  onClose,
}: {
  open: boolean
  title: string
  current: string
  hasOriginal: boolean
  loadPreview: (mode: CutoutMode) => Promise<Blob>
  onApply: (mode: CutoutMode) => Promise<unknown>
  onClose: () => void
}) {
  const [mode, setMode] = useState<CutoutMode>('algorithm')
  const [backdrop, setBackdrop] = useState<Backdrop>('checker')
  const [preview, setPreview] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  // 打开或换方式时重新预览；旧的 blob URL 用完就释放
  useEffect(() => {
    if (!open) return
    let url: string | null = null
    let cancelled = false
    setLoading(true)
    setError(null)
    loadPreview(mode)
      .then((blob) => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setPreview(url)
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setPreview(null)
          setError(errorMessage(e))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [open, mode, loadPreview])

  const backdropOptions: { value: Backdrop; label: string }[] = [
    { value: 'checker', label: t('棋盘格') },
    { value: 'dark', label: t('深色') },
    { value: 'light', label: t('浅色') },
  ]

  return (
    <Dialog open={open} onClose={onClose} title={title} className="sm:max-w-2xl">
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CutoutModePicker value={mode} onChange={setMode} disabled={applying} />
          <div className="flex items-center gap-1 text-xs text-zinc-500">
            <span className="mr-1">{t('底色')}</span>
            {backdropOptions.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={backdrop === o.value}
                onClick={() => setBackdrop(o.value)}
                className={cx(
                  'h-7 rounded-md px-2 transition-colors',
                  backdrop === o.value
                    ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100'
                    : 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Pane label={t('现在')} src={current} backdrop={backdrop} />
          <Pane label={t('重新抠图后')} src={preview} backdrop={backdrop} loading={loading} />
        </div>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}
        {!hasOriginal && (
          <p className="text-xs text-zinc-500">
            {t('这张图生成时还没有保存原图，会在现在的结果上再抠一次；之后都以现在这张为原图。')}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose} disabled={applying}>
            {t('取消')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={applying || loading || !preview}
            onClick={() => {
              setApplying(true)
              onApply(mode)
                .then(() => {
                  toast.info(t('已重新抠图'))
                  onClose()
                })
                .catch((e: unknown) => toast.error(errorMessage(e)))
                .finally(() => setApplying(false))
            }}
          >
            {applying ? t('应用中…') : t('应用')}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
