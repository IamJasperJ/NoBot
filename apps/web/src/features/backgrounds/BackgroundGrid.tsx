import type { BackgroundDTO, BackgroundFolderDTO } from '@nobot/shared'
import { type RefObject, useEffect, useState } from 'react'
import { FolderIcon, PlusIcon, TrashIcon, WandIcon } from '../../components/icons'
import { Button, cx, selectClass } from '../../components/ui'
import { t } from '../../i18n'

/** 设置里的列数按大约 300px 宽的侧栏算；面板更宽时按比例多加几列 */
export function useColumns(ref: RefObject<HTMLElement | null>, base: number) {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [ref])
  return width > 0 ? Math.max(base, Math.min(12, Math.round((base * width) / 300))) : base
}

/** 背景网格里的一张：缩略图、生效位置的角标（本聊天 / 舞台 / 全局）、来源角标和名字 */
export function BackgroundTile({
  background: b,
  chatId,
  active,
  disabled,
  selecting,
  marks,
  onClick,
}: {
  background: BackgroundDTO
  chatId: string | null
  /** 选择模式下是否勾选，否则是否是正在查看的那张 */
  active: boolean
  disabled: boolean
  selecting: boolean
  marks: { chat: boolean; stage: boolean; global: boolean }
  onClick: () => void
}) {
  const foreign = !!chatId && b.chatId !== null && b.chatId !== chatId
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      title={b.description ? `${b.name}\n${b.description}` : b.name}
      onClick={onClick}
      className="group min-w-0 text-left"
    >
      <div
        className={cx(
          'relative overflow-hidden rounded-lg bg-zinc-100 ring-2 ring-offset-2 ring-offset-white transition-shadow dark:bg-zinc-800 dark:ring-offset-zinc-950',
          active ? 'ring-violet-500' : 'ring-transparent group-hover:ring-zinc-200 dark:group-hover:ring-zinc-700',
        )}
      >
        {b.mime.startsWith('video/') ? (
          <video
            src={b.thumbUrl}
            muted
            preload="metadata"
            playsInline
            className={cx('aspect-video w-full object-cover', foreign && 'opacity-60')}
            aria-label={b.name}
          />
        ) : (
          <img
            src={b.thumbUrl}
            alt={b.name}
            loading="lazy"
            className={cx('aspect-video w-full object-cover', foreign && 'opacity-60')}
          />
        )}
        {selecting && (
          <span
            className={cx(
              'absolute top-1.5 right-1.5 z-10 flex size-5 items-center justify-center rounded-full border-2 text-[11px] text-white shadow',
              active ? 'border-violet-500 bg-violet-600' : 'border-white bg-black/30',
            )}
          >
            {active && '✓'}
          </span>
        )}
        <div className="absolute inset-x-1.5 top-1.5 flex flex-wrap gap-1 text-[10px] leading-4 font-medium text-white">
          {marks.chat && <span className="rounded bg-violet-600/90 px-1.5 shadow-sm">{t('本聊天')}</span>}
          {marks.stage && <span className="rounded bg-emerald-600/90 px-1.5 shadow-sm">{t('舞台')}</span>}
          {marks.global && <span className="rounded bg-zinc-900/75 px-1.5 shadow-sm">{t('全局')}</span>}
        </div>
        <div className="absolute right-1.5 bottom-1.5 left-1.5 flex justify-end gap-1 text-[10px] leading-4 font-medium text-white">
          {foreign && <span className="mr-auto rounded bg-black/55 px-1.5 backdrop-blur-sm">{t('其他会话')}</span>}
          {b.chatId !== null && b.chatId === chatId && (
            <span className="mr-auto rounded bg-black/55 px-1.5 backdrop-blur-sm">{t('本会话')}</span>
          )}
          {b.source === 'generated' && <span className="rounded bg-black/55 px-1.5 backdrop-blur-sm">AI</span>}
          {b.animated && <span className="rounded bg-black/55 px-1.5 backdrop-blur-sm">{t('动态')}</span>}
        </div>
      </div>
      <p className="mt-1.5 truncate text-xs" title={b.name}>
        {b.name}
      </p>
    </button>
  )
}

/** 文件夹列表：封面（没设封面就用文件夹里最新的一张）+ 名字 + 张数，最后一格是「新建」 */
export function FolderGrid({
  folders,
  backgrounds,
  columns,
  onOpen,
  onCreate,
}: {
  folders: BackgroundFolderDTO[]
  backgrounds: BackgroundDTO[]
  columns: number
  onOpen: (id: string) => void
  onCreate: () => void
}) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {folders.map((f) => {
        const items = backgrounds.filter((b) => b.folderIds.includes(f.id))
        const cover =
          backgrounds.find((b) => b.id === f.coverBackgroundId) ??
          [...items].sort((a, b) => b.createdAt - a.createdAt)[0]
        return (
          <button key={f.id} type="button" className="group min-w-0 text-left" onClick={() => onOpen(f.id)}>
            <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-zinc-100 ring-2 ring-transparent ring-offset-2 ring-offset-white group-hover:ring-zinc-200 dark:bg-zinc-800 dark:ring-offset-zinc-950 dark:group-hover:ring-zinc-700">
              {cover && !cover.mime.startsWith('video/') ? (
                <img src={cover.thumbUrl} alt="" loading="lazy" className="size-full object-cover" />
              ) : (
                <FolderIcon className="size-8 text-zinc-400" />
              )}
              <span className="absolute right-1.5 bottom-1.5 rounded bg-black/55 px-1.5 text-[10px] leading-4 font-medium text-white backdrop-blur-sm">
                {items.length}
              </span>
            </div>
            <p className="mt-1.5 flex items-center gap-1 truncate text-xs">
              <FolderIcon className="size-3.5 shrink-0 text-zinc-400" />
              <span className="truncate">{f.name}</span>
            </p>
          </button>
        )
      })}
      <button type="button" className="group min-w-0 text-left" onClick={onCreate}>
        <div className="flex aspect-video items-center justify-center rounded-lg border-2 border-dashed border-zinc-200 text-zinc-400 group-hover:border-violet-300 group-hover:text-violet-500 dark:border-zinc-700">
          <PlusIcon className="size-6" />
        </div>
        <p className="mt-1.5 truncate text-xs text-zinc-500">{t('新建文件夹')}</p>
      </button>
    </div>
  )
}

/** 选择模式的底部操作条 */
export function SelectionBar({
  count,
  folders,
  inFolder,
  busy,
  naming,
  allPicked,
  onAll,
  onAiName,
  onDelete,
  onAdd,
  onRemove,
  onDone,
}: {
  count: number
  folders: BackgroundFolderDTO[]
  inFolder: BackgroundFolderDTO | null
  busy: boolean
  naming: boolean
  allPicked: boolean
  onAll: () => void
  onAiName: () => void
  onDelete: () => void
  onAdd: (folderId: string) => void
  onRemove: () => void
  onDone: () => void
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-zinc-200 bg-white px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
      <span className="mr-auto text-xs text-zinc-500">{t('已选 {count} 张', { count })}</span>
      <Button size="sm" variant="ghost" onClick={onAll}>
        {allPicked ? t('全不选') : t('全选')}
      </Button>
      <select
        className={cx(selectClass, 'h-8 w-28 text-xs')}
        aria-label={t('加入文件夹')}
        value=""
        disabled={busy || !count || !folders.length}
        onChange={(e) => e.target.value && onAdd(e.target.value)}
      >
        <option value="">{folders.length ? t('加入文件夹…') : t('还没有文件夹')}</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      {inFolder && (
        <Button size="sm" disabled={busy || !count} onClick={onRemove}>
          {t('移出文件夹')}
        </Button>
      )}
      <Button
        size="sm"
        disabled={busy || !count}
        title={t('让看图模型给选中的背景起名并写描述（会覆盖原来的名字）')}
        onClick={onAiName}
      >
        <WandIcon />
        {naming ? t('正在起名…') : t('AI 起名')}
      </Button>
      <Button size="sm" variant="danger" disabled={busy || !count} onClick={onDelete}>
        <TrashIcon />
        {t('删除')}
      </Button>
      <Button size="sm" variant="primary" onClick={onDone}>
        {t('完成')}
      </Button>
    </div>
  )
}
