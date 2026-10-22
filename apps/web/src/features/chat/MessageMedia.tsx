import type { AttachmentDTO, MessageDTO } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { apiFetch } from '../../api/fetch'
import { replaceMessage, resetChat, useSetAttachmentCg } from '../../api/queries'
import { ChevronLeftIcon, ChevronRightIcon, StarIcon } from '../../components/icons'
import { Button, cx, IconButton } from '../../components/ui'
import { emitClientEvent, hasListener, useExtensionsRuntime } from '../../extensions/runtime'
import { Slot } from '../../extensions/Slot'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { ImagePromptDialog } from './ImagePromptDialog'

/**
 * 非轮播图片的显示宽度：放进 320×320 的框里按原比例缩放。
 * 框的宽度必须明确给出，否则外层按图片的百分比 max-width 反推宽度，框会比图片宽、露出底色。
 */
function fitWidth(image: { width?: number | null; height?: number | null }) {
  if (!image.width || !image.height) return 'min(320px, 100%)'
  const width = Math.min(320, image.width, (320 * image.width) / image.height)
  return `min(${Math.round(width)}px, 100%)`
}

/** 媒体独立于工具正文显示，异步任务更新元数据后直接替换占位内容。 */
export function MessageMedia({ msg, chatId }: { msg: MessageDTO; chatId: string }) {
  const qc = useQueryClient()
  // 扩展热启停时重新判断「生成备选」是否可用
  useExtensionsRuntime((s) => s.listeners)
  const canGenerateAlternative = hasListener('image:swipe-next')
  const [saving, setSaving] = useState(false)
  const [editingPrompt, setEditingPrompt] = useState(false)
  const [expandedError, setExpandedError] = useState(false)
  const task = msg.meta.imageGen
  const images = msg.meta.images ?? []
  const hasTaskFrame = task?.status === 'pending' || task?.status === 'error'
  const count = images.length + (hasTaskFrame ? 1 : 0)
  const carousel = !!task && count > 0
  const imageIndex = Math.max(0, Math.min(msg.meta.imageIndex ?? count - 1, count - 1))
  const showTaskFrame = hasTaskFrame && imageIndex === images.length
  const imageAction = async (action: 'retry' | 'dismiss' | 'cancel', edited?: { prompt: string; negative: string }) => {
    if (saving) return
    if (action === 'dismiss' && !images.length && !confirm(t('放弃后将删除这条消息及后面的所有分支，确定放弃？')))
      return
    setSaving(true)
    try {
      const response = await apiFetch(`/api/ext/image-gen/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: msg.id, ...edited }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error?.message ?? t('图片操作失败'))
      if (data.message) replaceMessage(qc, chatId, data.message)
      if (data.deleted) await resetChat(qc, chatId)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  const switchImage = async (direction: -1 | 1) => {
    if (saving) return
    const next = imageIndex + direction
    // 和文字回复的切换一样：在最后一张再往右就是「生成备选图」（保留现有图片，再生成一张）
    if (next >= count) {
      if (!hasTaskFrame && canGenerateAlternative) emitClientEvent({ type: 'image:swipe-next', chatId, message: msg })
      return
    }
    if (next < 0) return
    setSaving(true)
    replaceMessage(qc, chatId, { ...msg, meta: { ...msg.meta, imageIndex: next } })
    try {
      replaceMessage(qc, chatId, await api.updateMessageImageIndex(msg.id, next))
    } catch (e) {
      replaceMessage(qc, chatId, msg)
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }
  const ratio =
    task?.width && task.width > 0 && task.height && task.height > 0 ? `${task.width} / ${task.height}` : '1 / 1'
  // 生成的图片、占位框、失败框统一宽度，切换时不跳动
  const frameStyle = { width: 'min(320px, 100%)', aspectRatio: ratio }
  const stageText =
    task?.stage === 'prompt'
      ? t('正在写提示词…')
      : task?.stage === 'confirm'
        ? t('等待确认…')
        : task?.stage === 'queued'
          ? t('排队中 · 第 {position} 位', { position: task.queuePosition ?? 1 })
          : task?.stage === 'saving'
            ? t('保存中…')
            : t('生成中…')
  const cancelled = task?.error === t('已取消')
  // 没有图片也没有图片任务的消息不渲染这一块，避免在正文上方留出空白
  if (!images.length && !task) return null
  return (
    <div className="group/media my-2 space-y-1">
      {images.length > 0 && imageIndex < images.length && (
        <div className="flex flex-wrap gap-2">
          {images.map(
            (image, index) =>
              (!carousel || index === imageIndex) && (
                <a
                  key={image.id}
                  href={image.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded-xl bg-zinc-100 ring-1 ring-black/5 dark:bg-zinc-800 dark:ring-white/10"
                  style={{ width: carousel ? 'min(320px, 100%)' : fitWidth(image) }}
                >
                  <img
                    src={image.url}
                    alt={t('图片 {index}', { index: index + 1 })}
                    loading="lazy"
                    className="block h-auto w-full object-contain"
                    style={
                      image.width && image.height ? { aspectRatio: `${image.width} / ${image.height}` } : undefined
                    }
                  />
                </a>
              ),
          )}
        </div>
      )}
      {showTaskFrame && task?.status === 'pending' && (
        <div
          role="status"
          className="relative flex max-w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-xl bg-zinc-100 p-4 text-center ring-1 ring-black/5 dark:bg-zinc-800/60 dark:ring-white/10"
          style={frameStyle}
        >
          {/* 缓慢流动的光带，提示正在生成 */}
          <div className="pointer-events-none absolute inset-0 animate-pulse bg-gradient-to-br from-violet-500/5 via-transparent to-violet-500/10" />
          <span
            aria-hidden="true"
            className="size-7 animate-spin rounded-full border-2 border-zinc-300 border-t-violet-500 dark:border-zinc-600 dark:border-t-violet-400"
          />
          <span className="text-sm font-medium text-zinc-600 dark:text-zinc-300">{stageText}</span>
          {task.prompt && (
            <span className="line-clamp-2 max-w-full px-2 text-xs break-words text-zinc-400">
              {task.prompt.slice(0, 80)}
            </span>
          )}
          <Button size="sm" disabled={saving} onClick={() => void imageAction('cancel')}>
            {t('取消')}
          </Button>
        </div>
      )}
      {showTaskFrame && task?.status === 'error' && (
        <div
          role="alert"
          className={cx(
            'flex max-w-full flex-col items-center justify-center gap-2.5 overflow-auto rounded-xl p-4 text-center ring-1',
            cancelled
              ? 'bg-zinc-100 text-zinc-500 ring-black/5 dark:bg-zinc-800/60 dark:ring-white/10'
              : 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900',
          )}
          style={frameStyle}
        >
          <span
            aria-hidden="true"
            className={cx(
              'flex size-9 items-center justify-center rounded-full text-lg',
              cancelled ? 'bg-zinc-200 dark:bg-zinc-700' : 'bg-red-100 dark:bg-red-900/60',
            )}
          >
            {cancelled ? '⏹' : '!'}
          </span>
          <strong className="text-sm">{cancelled ? t('已取消') : t('图片生成失败')}</strong>
          {!cancelled && (
            <div className="w-full min-w-0">
              <p className={cx('text-xs break-words whitespace-pre-wrap opacity-90', !expandedError && 'line-clamp-3')}>
                {task.error || t('未知错误')}
              </p>
              {!!task.error && task.error.length > 60 && (
                <button
                  type="button"
                  className="mt-1 text-xs underline underline-offset-2 opacity-70 hover:opacity-100"
                  onClick={() => setExpandedError(!expandedError)}
                >
                  {expandedError ? t('收起') : t('详情')}
                </button>
              )}
            </div>
          )}
          {task.prompt && (
            <span className="line-clamp-2 max-w-full text-xs break-words opacity-60">{task.prompt.slice(0, 80)}</span>
          )}
          <div className="flex flex-wrap justify-center gap-1.5">
            <Button size="sm" disabled={saving} onClick={() => void imageAction('retry')}>
              {t('重新生成')}
            </Button>
            <Button size="sm" disabled={saving} onClick={() => setEditingPrompt(true)}>
              {t('改提示词…')}
            </Button>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => void imageAction('dismiss')}>
              {t('放弃')}
            </Button>
          </div>
        </div>
      )}
      {/* 一行工具栏：备选切换 + 扩展按钮（重新生成、设为背景）。桌面端悬停时才完全显示 */}
      <div className="flex min-h-8 flex-wrap items-center gap-0.5 text-xs text-zinc-500 transition-opacity [@media(hover:hover)]:opacity-50 [@media(hover:hover)]:group-hover/media:opacity-100 [@media(hover:hover)]:focus-within:opacity-100">
        {carousel && (count > 1 || canGenerateAlternative) && (
          <div className="mr-1 flex items-center rounded-lg">
            <IconButton
              label={t('上一张图片')}
              disabled={saving || imageIndex === 0}
              onClick={() => void switchImage(-1)}
            >
              <ChevronLeftIcon />
            </IconButton>
            <span className="min-w-8 text-center tabular-nums">{`${imageIndex + 1}/${count}`}</span>
            {(() => {
              const atLast = imageIndex === count - 1
              const generate = atLast && !hasTaskFrame && canGenerateAlternative
              return (
                <IconButton
                  label={generate ? t('生成备选图（保留现有图片，再生成一张）') : t('下一张图片')}
                  disabled={saving || (atLast && !generate)}
                  onClick={() => void switchImage(1)}
                >
                  <ChevronRightIcon />
                </IconButton>
              )
            })()}
          </div>
        )}
        {!showTaskFrame && images[imageIndex] && <CgToggle image={images[imageIndex]} />}
        {task && <Slot name="chat.message.media" props={{ chatId, message: msg }} />}
      </div>
      {editingPrompt && task && (
        <ImagePromptDialog
          review={{
            preview: { prompt: task.prompt ?? '', negative: task.negative ?? '' },
            resolve: (edited) => {
              setEditingPrompt(false)
              if (edited) void imageAction('retry', edited)
            },
          }}
        />
      )}
    </div>
  )
}

/** 图片工具栏上的星标：收进 / 移出这个角色的 CG 画廊 */
function CgToggle({ image }: { image: AttachmentDTO }) {
  const setCg = useSetAttachmentCg()
  return (
    <IconButton
      label={image.isCg ? t('移出 CG 画廊') : t('收进 CG 画廊')}
      disabled={setCg.isPending}
      className={image.isCg ? 'text-amber-500' : undefined}
      onClick={() =>
        setCg.mutate({ id: image.id, isCg: !image.isCg }, { onError: (e) => toast.error(errorMessage(e)) })
      }
    >
      <StarIcon filled={image.isCg} />
    </IconButton>
  )
}
