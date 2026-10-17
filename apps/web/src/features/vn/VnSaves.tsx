import type { BookmarkDTO, PlayPresetData } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { keys, resetChat, useBookmarks } from '../../api/queries'
import { PlusIcon, TrashIcon, XIcon } from '../../components/icons'
import { cx } from '../../components/ui'
import { getLanguage, t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'

/**
 * VN 的存档 / 读档：存档就是一种书签（kind = save），存的时候后端把舞台拍成快照（背景、台上的人、地点、常驻变量），
 * 这里用快照画缩略图。读档 = 切到那条消息所在的分支，从那里接着玩就自然分出一条新分支，原来的进度还在
 */
export function VnSaves({
  chatId,
  play,
  currentId,
  onLoaded,
  onClose,
}: {
  chatId: string
  play: PlayPresetData
  /** 存哪条消息；null = 当前分支的最新位置 */
  currentId: string | null
  onLoaded: () => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  const bookmarks = useBookmarks(chatId)
  const saves = (bookmarks.data ?? []).filter((b) => b.kind === 'save').sort((a, b) => b.createdAt - a.createdAt)
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const save = () =>
    run(async () => {
      const created = await api.createSave(chatId, currentId ? { messageId: currentId } : {})
      await qc.invalidateQueries({ queryKey: keys.bookmarks(chatId) })
      toast.info(t('已存档「{name}」', { name: created.name }))
    })
  const load = (b: BookmarkDTO) =>
    run(async () => {
      // 读档停在存档那一条：从那里接着玩会自然分出一条新分支，原来的进度还在
      await api.activateMessage(chatId, b.messageId, true)
      await resetChat(qc, chatId)
      toast.info(t('已读档「{name}」', { name: b.name }))
      onLoaded()
    })
  const remove = (b: BookmarkDTO) => {
    if (!confirm(t('删除存档「{name}」？（不会删除聊天内容）', { name: b.name }))) return
    void run(async () => {
      await api.deleteBookmark(b.id)
      await qc.invalidateQueries({ queryKey: keys.bookmarks(chatId) })
    })
  }
  const time = (ms: number) =>
    new Date(ms).toLocaleString(getLanguage() === 'en' ? 'en-US' : 'zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center p-3 md:p-8">
      <button type="button" aria-label={t('关闭存档')} className="absolute inset-0 bg-black/55" onClick={onClose} />
      <div
        role="dialog"
        aria-label={t('存档 / 读档')}
        className="vn-backlog relative flex max-h-full w-full max-w-4xl flex-col overflow-hidden rounded-2xl"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-white/10 px-4">
          <h2 className="flex-1 font-semibold">{t('存档 / 读档')}</h2>
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="vn-chip vn-chip-active flex h-8 items-center gap-1 rounded-full px-3 text-xs disabled:opacity-50 [&_svg]:size-3.5"
          >
            <PlusIcon />
            {currentId ? t('存这一条') : t('存到这里')}
          </button>
          <button
            type="button"
            aria-label={t('关闭存档')}
            className="vn-chip flex size-8 items-center justify-center rounded-full"
            onClick={onClose}
          >
            <XIcon className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {saves.length === 0 ? (
            <p className="py-10 text-center text-sm opacity-60">
              {t('还没有存档。点右上角「存到这里」保存当前进度。')}
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {saves.map((b) => (
                <li key={b.id} className="group overflow-hidden rounded-xl bg-white/5 ring-1 ring-white/10">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void load(b)}
                    title={t('读档')}
                    className="block w-full text-left disabled:opacity-60"
                  >
                    {play.interaction.saveThumb && <Thumb save={b} />}
                    <div className="space-y-1 p-2.5">
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{b.name}</span>
                        <span className="shrink-0 text-[11px] tabular-nums opacity-50">{time(b.createdAt)}</span>
                      </div>
                      {b.snapshot?.text && <p className="line-clamp-2 text-xs opacity-70">{b.snapshot.text}</p>}
                      {!!b.snapshot?.vars.length && (
                        <div className="flex flex-wrap gap-1 pt-0.5">
                          {b.snapshot.vars.map(([label, value]) => (
                            <span key={label} className="rounded bg-white/10 px-1.5 py-0.5 text-[11px]">
                              <span className="opacity-60">{label}</span> {value}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </button>
                  <div className="flex justify-end border-t border-white/5 px-1.5 py-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => remove(b)}
                      aria-label={t('删除存档')}
                      className="flex size-7 items-center justify-center rounded-full opacity-50 hover:bg-white/10 hover:text-rose-300 hover:opacity-100 [&_svg]:size-3.5"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

/** 存档缩略图：背景铺满，台上的人按立绘（没有立绘用头像）从左到右站好，左上角写地点和时间 */
function Thumb({ save }: { save: BookmarkDTO }) {
  const snap = save.snapshot
  const actors = snap?.actors ?? []
  return (
    <div className="relative aspect-video overflow-hidden bg-gradient-to-br from-zinc-700 to-zinc-900">
      {snap?.backgroundUrl && (
        <img src={snap.backgroundUrl} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
      )}
      <div className="absolute inset-x-0 bottom-0 flex h-[85%] items-end justify-center gap-[4%]">
        {actors.map((actor, i) =>
          actor.spriteUrl ? (
            <img
              // 演员名可能重复（同名 NPC），带上下标
              key={`${actor.name}:${i}`}
              src={actor.spriteUrl}
              alt={actor.name}
              loading="lazy"
              className="h-full w-auto max-w-[45%] object-contain object-bottom drop-shadow-[0_4px_12px_rgb(0_0_0/0.4)]"
            />
          ) : actor.avatarUrl ? (
            <img
              key={`${actor.name}:${i}`}
              src={actor.avatarUrl}
              alt={actor.name}
              loading="lazy"
              className="mb-[8%] aspect-[3/4] h-1/2 rounded-lg border border-white/60 object-cover shadow-lg"
            />
          ) : null,
        )}
      </div>
      {(snap?.place || snap?.time) && (
        <span
          className={cx(
            'absolute top-1.5 left-1.5 max-w-[80%] truncate rounded-full bg-black/55 px-2 py-0.5 text-[11px] text-white',
          )}
        >
          {[snap.place, snap.time].filter(Boolean).join(' · ')}
        </span>
      )}
    </div>
  )
}
