import type { ChatSummary } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { api } from '../../api/client'
import { keys, useCharacters, useChats, useGroups } from '../../api/queries'
import { PlusIcon, SettingsIcon, TrashIcon, UploadIcon, UsersIcon } from '../../components/icons'
import { Avatar, Button, cx, IconButton } from '../../components/ui'
import { Slot } from '../../extensions/Slot'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { GroupDialog } from '../groups/GroupDialog'
import { useCharacterImport } from './useCharacterImport'

type Owner = { characterId: string } | { groupId: string }

/** 某个角色或群组下的会话列表 */
function ChatList({ owner }: { owner: Owner }) {
  const qc = useQueryClient()
  const chats = useChats(owner)
  const { chatId, openChat } = useUi()

  const create = async () => {
    try {
      const chat = await api.createChat(owner)
      await qc.invalidateQueries({ queryKey: keys.chats(owner) })
      openChat(owner, chat.id)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const remove = async (c: ChatSummary) => {
    if (!confirm(t('删除会话「{title}」？所有消息都会被删除。', { title: c.title }))) return
    try {
      await api.deleteChat(c.id)
      if (c.id === chatId) openChat(owner, null)
      await qc.invalidateQueries({ queryKey: keys.chats(owner) })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  // 打开这个会话并展开它的会话设置
  const openSettings = (c: ChatSummary) => {
    openChat(owner, c.id)
    const ui = useUi.getState()
    ui.setPreviewOpen(false)
    ui.setChatSettingsOpen(true)
    ui.openView('chat')
  }

  return (
    <div className="mt-1 mb-2 ml-6 space-y-0.5 border-l border-zinc-200 pl-2 dark:border-zinc-800">
      {chats.data?.map((c) => (
        <div
          key={c.id}
          className={cx(
            'group flex items-center rounded-lg text-sm',
            c.id === chatId ? 'bg-violet-100 dark:bg-violet-950' : 'hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60',
          )}
        >
          <button
            type="button"
            className="min-w-0 flex-1 truncate px-2 py-1.5 text-left"
            onClick={() => openChat(owner, c.id)}
          >
            {c.title}
          </button>
          <IconButton
            label={t('会话设置')}
            className="size-7 opacity-0 group-hover:opacity-100 max-md:opacity-100"
            onClick={() => openSettings(c)}
          >
            <SettingsIcon width={15} height={15} />
          </IconButton>
          <IconButton
            label={t('删除会话')}
            className="size-7 opacity-0 group-hover:opacity-100 max-md:opacity-100"
            onClick={() => remove(c)}
          >
            <TrashIcon width={15} height={15} />
          </IconButton>
        </div>
      ))}
      <button
        type="button"
        onClick={create}
        className="flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-violet-600 hover:bg-zinc-200/60 dark:text-violet-400 dark:hover:bg-zinc-800/60"
      >
        <PlusIcon width={15} height={15} /> {t('新建会话')}
      </button>
    </div>
  )
}

/** 聊天页的侧栏：角色和群聊，展开后是各自的会话列表 */
export function Sidebar() {
  const qc = useQueryClient()
  const characters = useCharacters()
  const groups = useGroups()
  const { characterId, groupId, selectCharacter, selectGroup } = useUi()
  const fileRef = useRef<HTMLInputElement>(null)
  const { importing, importFiles, importDialog } = useCharacterImport((c) => selectCharacter(c.id))
  const [groupDialog, setGroupDialog] = useState(false)

  return (
    <aside className="flex h-full w-full flex-col border-r border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900">
      <header className="flex h-14 shrink-0 items-center px-4 font-semibold tracking-tight">{t('聊天')}</header>

      <div className="flex gap-2 px-3 pb-2">
        <Button className="flex-1" onClick={() => fileRef.current?.click()} disabled={importing}>
          <UploadIcon width={16} height={16} />
          {importing ? t('导入中…') : t('导入角色卡')}
        </Button>
        <Button onClick={() => setGroupDialog(true)} title={t('新建群聊')}>
          <UsersIcon width={16} height={16} />
          {t('群聊')}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".png,.json,.charx"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = '' // 允许重复选择同一个文件
            void importFiles(files)
          }}
        />
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {groups.data && groups.data.length > 0 && (
          <>
            <div className="px-2 pt-2 pb-1 text-xs font-medium text-zinc-500">{t('群聊')}</div>
            {groups.data.map((g) => (
              <div key={g.id}>
                <button
                  type="button"
                  onClick={() => selectGroup(g.id === groupId ? null : g.id)}
                  className={cx(
                    'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left',
                    g.id === groupId
                      ? 'bg-zinc-200 dark:bg-zinc-800'
                      : 'hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60',
                  )}
                >
                  <div className="flex -space-x-2">
                    {g.members.slice(0, 3).map((m) => (
                      <Avatar key={m.characterId} name={m.name} url={m.avatarUrl} size={24} />
                    ))}
                  </div>
                  <span className="truncate text-sm font-medium">{g.name}</span>
                </button>
                {g.id === groupId && <ChatList owner={{ groupId: g.id }} />}
              </div>
            ))}
            <div className="px-2 pt-3 pb-1 text-xs font-medium text-zinc-500">{t('角色')}</div>
          </>
        )}

        {characters.data?.length === 0 && (
          <p className="px-2 py-6 text-center text-sm text-zinc-500">
            {t('还没有角色，导入一张酒馆角色卡（PNG 或 JSON）试试')}
          </p>
        )}
        {characters.data?.map((c) => (
          <div key={c.id}>
            <button
              type="button"
              onClick={() => selectCharacter(c.id === characterId ? null : c.id)}
              className={cx(
                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left',
                c.id === characterId
                  ? 'bg-zinc-200 dark:bg-zinc-800'
                  : 'hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60',
              )}
            >
              <Avatar name={c.name} url={c.avatarUrl} size={32} />
              <span className="truncate text-sm font-medium">{c.name}</span>
            </button>
            {c.id === characterId && <ChatList owner={{ characterId: c.id }} />}
          </div>
        ))}
      </nav>

      {importDialog}
      <Slot name="sidebar.footer" props={{}} />
      <GroupDialog
        open={groupDialog}
        groupId={null}
        onClose={() => setGroupDialog(false)}
        onSaved={(g) => {
          setGroupDialog(false)
          void qc.invalidateQueries({ queryKey: keys.groups })
          selectGroup(g.id)
        }}
      />
    </aside>
  )
}
