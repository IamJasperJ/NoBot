import type { TrashItemDTO } from '@nobot/shared'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { keys } from '../../api/queries'
import { RefreshIcon, TrashIcon, UsersIcon } from '../../components/icons'
import { Avatar, Button, Dialog, IconButton } from '../../components/ui'
import { getLanguage, t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'

const trashKey = ['trash'] as const

/**
 * 回收站：删除的角色和群组先放在这里（连同它们的会话），可以恢复；
 * 「彻底删除」才会真正删掉会话、消息、头像和立绘
 */
export function TrashDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const trash = useQuery({ queryKey: trashKey, queryFn: api.listTrash, enabled: open })
  const [busy, setBusy] = useState(false)
  const items = trash.data?.items ?? []

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: trashKey }),
      qc.invalidateQueries({ queryKey: keys.characters }),
      qc.invalidateQueries({ queryKey: keys.groups }),
    ])
  }
  const run = async (action: () => Promise<unknown>, done: string) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
      await refresh()
      toast.info(done)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const purge = (item: TrashItemDTO) => {
    const message =
      item.chats > 0
        ? t('彻底删除「{name}」和它的 {count} 个会话？删除后无法恢复。', { name: item.name, count: item.chats })
        : t('彻底删除「{name}」？删除后无法恢复。', { name: item.name })
    if (confirm(message)) void run(() => api.purgeTrash(item.kind, item.id), t('已彻底删除'))
  }
  const time = (ms: number) =>
    new Date(ms).toLocaleString(getLanguage() === 'en' ? 'en-US' : 'zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

  return (
    <Dialog open={open} onClose={onClose} title={t('回收站')}>
      <div className="space-y-3">
        <p className="text-xs text-zinc-500">
          {t('删除的角色和群组会先放在这里，连同它们的会话，可以随时恢复。彻底删除后无法找回。')}
        </p>
        {trash.isPending ? (
          <p className="text-sm text-zinc-400">{t('加载中…')}</p>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-400">{t('回收站是空的')}</p>
        ) : (
          <ul className="max-h-[60vh] divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-800">
            {items.map((item) => (
              <li key={`${item.kind}:${item.id}`} className="flex items-center gap-3 py-2">
                {item.kind === 'character' ? (
                  <Avatar name={item.name} url={item.avatarUrl} />
                ) : (
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-500 dark:bg-zinc-800">
                    <UsersIcon />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{item.name}</div>
                  <div className="text-xs text-zinc-400">
                    {item.kind === 'character' ? t('角色') : t('群组')} · {t('{count} 个会话', { count: item.chats })} ·{' '}
                    {t('删除于 {time}', { time: time(item.deletedAt) })}
                  </div>
                </div>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.restoreTrash(item.kind, item.id), t('已恢复「{name}」', { name: item.name }))
                  }
                >
                  <RefreshIcon />
                  {t('恢复')}
                </Button>
                <IconButton label={t('彻底删除')} variant="danger" disabled={busy} onClick={() => purge(item)}>
                  <TrashIcon />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        {items.length > 0 && (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => {
                if (
                  confirm(
                    t('清空回收站？里面的 {count} 项和它们的会话都会被彻底删除，无法恢复。', { count: items.length }),
                  )
                )
                  void run(() => api.emptyTrash(), t('回收站已清空'))
              }}
            >
              {t('清空回收站')}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  )
}
