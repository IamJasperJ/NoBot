import type { BookmarkDTO } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { keys, resetChat, useBookmarks } from '../../api/queries'
import { Section } from '../../components/form'
import { BranchIcon, CheckIcon, EditIcon, TrashIcon, XIcon } from '../../components/icons'
import { cx, IconButton, inputClass } from '../../components/ui'
import { useMobile } from '../../hooks/useMobile'
import { t } from '../../i18n'
import { useChatOps } from '../../stores/chatOps'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'

/**
 * 会话设置里的「书签」：点一条跳过去（不在当前分支时先切到那条分支），可以改名、删除、从这里开分支（复制成新会话）。
 * 书签在消息的 ⋯ 菜单里添加
 */
export function BookmarksSection({
  chatId,
  owner,
}: {
  chatId: string
  owner: { characterId?: string; groupId?: string }
}) {
  const qc = useQueryClient()
  const bookmarks = useBookmarks(chatId)
  const mobile = useMobile()
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  // 存档（VN 里存的）在 VN 视图的「存档 / 读档」里管理，这里只列普通书签
  const list = (bookmarks.data ?? []).filter((b) => b.kind === 'bookmark')
  const refresh = () => qc.invalidateQueries({ queryKey: keys.bookmarks(chatId) })

  const go = async (b: BookmarkDTO) => {
    try {
      if (!b.onPath) {
        await api.activateMessage(chatId, b.messageId)
        await resetChat(qc, chatId)
        void refresh()
        toast.info(t('已切换到书签所在的分支'))
      }
      useChatOps.getState().jumpTo(chatId, b.messageId)
      // 手机上设置面板盖住了聊天，跳转后关掉它
      if (mobile) useUi.getState().setChatSettingsOpen(false)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const rename = async () => {
    if (!renaming?.name.trim()) return
    try {
      await api.renameBookmark(renaming.id, renaming.name.trim())
      setRenaming(null)
      await refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const remove = async (b: BookmarkDTO) => {
    if (!confirm(t('删除书签「{name}」？（消息不会被删除）', { name: b.name }))) return
    try {
      await api.deleteBookmark(b.id)
      await refresh()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const branch = async (b: BookmarkDTO) => {
    try {
      const chat = await api.branch(chatId, b.messageId)
      await qc.invalidateQueries({ queryKey: keys.chats(owner) })
      useUi.getState().openChat(owner, chat.id)
      toast.info(t('已从书签开出新会话'))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <Section title={t('书签')} description={t('在消息的 ⋯ 菜单里「加书签」。点书签跳过去，不在当前分支时会先切过去')}>
      {list.length === 0 ? (
        <p className="text-xs text-zinc-400">{t('还没有书签。')}</p>
      ) : (
        <ul className="space-y-1">
          {list.map((b) => (
            <li
              key={b.id}
              className="group/bm flex items-start gap-1 rounded-lg px-1 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-900"
            >
              {renaming?.id === b.id ? (
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <input
                    aria-label={t('书签名字')}
                    className={cx(inputClass, 'h-8 text-[13px]')}
                    value={renaming.name}
                    maxLength={60}
                    onChange={(e) => setRenaming({ id: b.id, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void rename()
                      if (e.key === 'Escape') setRenaming(null)
                    }}
                    // biome-ignore lint/a11y/noAutofocus: 点了改名就该直接能输入
                    autoFocus
                  />
                  <IconButton label={t('保存名字')} onClick={() => void rename()}>
                    <CheckIcon />
                  </IconButton>
                  <IconButton label={t('取消改名')} onClick={() => setRenaming(null)}>
                    <XIcon />
                  </IconButton>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void go(b)}
                    title={t('跳到这条消息')}
                    className="min-w-0 flex-1 rounded-md px-1.5 py-0.5 text-left"
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium">{b.name}</span>
                      {!b.onPath && (
                        <span className="shrink-0 rounded bg-zinc-100 px-1 text-[10px] text-zinc-500 dark:bg-zinc-800">
                          {t('其他分支')}
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-zinc-400">
                      {b.preview.name ? `${b.preview.name}：` : ''}
                      {b.preview.text}
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center opacity-100 transition-opacity md:opacity-0 md:group-hover/bm:opacity-100 md:focus-within:opacity-100">
                    <IconButton label={t('改名')} onClick={() => setRenaming({ id: b.id, name: b.name })}>
                      <EditIcon />
                    </IconButton>
                    <IconButton label={t('从这里开分支（复制成新会话）')} onClick={() => void branch(b)}>
                      <BranchIcon />
                    </IconButton>
                    <IconButton label={t('删除书签')} variant="danger" onClick={() => void remove(b)}>
                      <TrashIcon />
                    </IconButton>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
