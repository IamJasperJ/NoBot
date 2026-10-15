import type { CharacterSummary } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { type ChangeEvent, useRef, useState } from 'react'
import { api } from '../../api/client'
import { keys, useCharacters, useChats } from '../../api/queries'
import { PlusIcon, SettingsIcon, TrashIcon, UploadIcon } from '../../components/icons'
import { Avatar, Button, cx, IconButton } from '../../components/ui'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'

/** 某个角色下的会话列表 */
function ChatList({ character }: { character: CharacterSummary }) {
  const qc = useQueryClient()
  const chats = useChats(character.id)
  const { chatId, selectChat } = useUi()

  const create = async () => {
    try {
      const chat = await api.createChat({ characterId: character.id })
      await qc.invalidateQueries({ queryKey: keys.chats(character.id) })
      selectChat(character.id, chat.id)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const remove = async (id: string) => {
    if (!confirm('删除这个会话？所有消息都会被删除。')) return
    try {
      await api.deleteChat(id)
      if (id === chatId) selectChat(character.id, null)
      await qc.invalidateQueries({ queryKey: keys.chats(character.id) })
    } catch (e) {
      toast.error(errorMessage(e))
    }
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
            onClick={() => selectChat(character.id, c.id)}
          >
            {c.title}
          </button>
          <IconButton
            label="删除会话"
            className="size-7 opacity-0 group-hover:opacity-100"
            onClick={() => remove(c.id)}
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
        <PlusIcon width={15} height={15} /> 新建会话
      </button>
    </div>
  )
}

export function Sidebar() {
  const qc = useQueryClient()
  const characters = useCharacters()
  const { characterId, selectCharacter, setSettingsOpen, sidebarOpen, setSidebarOpen } = useUi()
  const fileRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)

  const onImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])]
    e.target.value = '' // 允许重复选择同一个文件
    if (files.length === 0) return
    setImporting(true)
    for (const file of files) {
      try {
        const c = await api.importCharacter(file)
        toast.info(`已导入「${c.name}」`)
        selectCharacter(c.id)
      } catch (err) {
        toast.error(`${file.name}：${errorMessage(err)}`)
      }
    }
    setImporting(false)
    await qc.invalidateQueries({ queryKey: keys.characters })
  }

  const removeCharacter = async (c: CharacterSummary) => {
    if (!confirm(`删除角色「${c.name}」？它的所有会话也会一起删除。`)) return
    try {
      await api.deleteCharacter(c.id)
      if (c.id === characterId) selectCharacter(null)
      await qc.invalidateQueries({ queryKey: keys.characters })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <>
      {/* 手机上侧栏是抽屉，点遮罩关闭 */}
      {sidebarOpen && (
        <button
          type="button"
          aria-label="关闭侧栏"
          className="fixed inset-0 z-20 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-30 flex w-72 flex-col border-r border-zinc-200 bg-zinc-100 max-md:transition-transform md:static md:translate-x-0 dark:border-zinc-800 dark:bg-zinc-900',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <header className="flex h-14 shrink-0 items-center gap-2 px-4">
          <div className="flex-1 font-semibold tracking-tight">AI-Parter</div>
          <IconButton label="设置" onClick={() => setSettingsOpen(true)}>
            <SettingsIcon />
          </IconButton>
        </header>

        <div className="px-3 pb-2">
          <Button className="w-full" onClick={() => fileRef.current?.click()} disabled={importing}>
            <UploadIcon width={16} height={16} />
            {importing ? '导入中…' : '导入角色卡'}
          </Button>
          <input ref={fileRef} type="file" accept=".png,.json" multiple hidden onChange={onImport} />
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {characters.data?.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-zinc-500">
              还没有角色，导入一张酒馆角色卡（PNG 或 JSON）试试
            </p>
          )}
          {characters.data?.map((c) => (
            <div key={c.id}>
              <div
                className={cx(
                  'group flex items-center gap-2 rounded-lg px-2 py-1.5',
                  c.id === characterId
                    ? 'bg-zinc-200 dark:bg-zinc-800'
                    : 'hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60',
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() => selectCharacter(c.id === characterId ? null : c.id)}
                >
                  <Avatar name={c.name} url={c.avatarUrl} size={32} />
                  <span className="truncate text-sm font-medium">{c.name}</span>
                </button>
                <IconButton
                  label="删除角色"
                  className="size-7 opacity-0 group-hover:opacity-100"
                  onClick={() => removeCharacter(c)}
                >
                  <TrashIcon width={15} height={15} />
                </IconButton>
              </div>
              {c.id === characterId && <ChatList character={c} />}
            </div>
          ))}
        </nav>
      </aside>
    </>
  )
}
