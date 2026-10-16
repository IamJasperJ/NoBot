import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { api } from '../../api/client'
import { keys, useAutoBackground, useBackgroundSettings, useBackgrounds, useChatPages } from '../../api/queries'
import { TextField } from '../../components/form'
import { EditIcon, LinkIcon, SearchIcon, TrashIcon, UploadIcon, WandIcon } from '../../components/icons'
import { Button, controlClass, cx, Dialog, IconButton, selectClass } from '../../components/ui'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'

export function BackgroundsPage() {
  const auto = useAutoBackground()
  const backgrounds = useBackgrounds()
  const settings = useBackgroundSettings()
  const chatId = useUi((s) => s.chatId)
  const pages = useChatPages(chatId)
  const chat = pages.data?.pages[0]?.chat
  const stageBg = pages.data?.pages[0]?.stage?.scene
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'latest' | 'name'>('latest')
  const [importing, setImporting] = useState(false)
  const [url, setUrl] = useState('')
  const [importName, setImportName] = useState('')
  const list = backgrounds.data ?? []
  const filtered = list
    .filter((b) => b.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
    .sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : b.createdAt - a.createdAt || b.id.localeCompare(a.id),
    )
  const current = list.find((b) => b.id === selected)
  const globalId = settings.data?.globalId
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: keys.backgrounds }),
      qc.invalidateQueries({ queryKey: keys.backgroundSettings }),
      qc.invalidateQueries({ queryKey: ['chat'] }),
    ])
  }
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      await refresh()
      setBusy(false)
    }
  }
  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-zinc-200 px-3 dark:border-zinc-800">
        <h1 className="mr-auto font-semibold">背景</h1>
        {chatId && (
          <IconButton
            label={auto.isPending ? '正在让模型挑选…' : '自动选择：让模型挑一张最适合当前场景的背景'}
            disabled={busy || auto.isPending}
            onClick={() => {
              auto.mutate(chatId, {
                onSuccess: ({ background }) => toast.info(`已选择：${background.name}`),
                onError: (error) => toast.error(errorMessage(error)),
              })
            }}
          >
            <WandIcon className={auto.isPending ? 'animate-pulse' : ''} />
          </IconButton>
        )}
        <IconButton label="从网址添加" disabled={busy} onClick={() => setImporting(true)}>
          <LinkIcon />
        </IconButton>
        <Button size="sm" variant="primary" className="ml-1" disabled={busy} onClick={() => input.current?.click()}>
          <UploadIcon />
          {busy ? '处理中…' : '上传'}
        </Button>
        <input
          ref={input}
          type="file"
          accept="image/*,video/mp4,video/webm"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            if (!files.length) return
            void run(async () => {
              let uploaded = 0
              for (const file of files) {
                try {
                  await api.uploadBackground(file)
                  uploaded++
                } catch (error) {
                  toast.error(`${file.name}：${errorMessage(error)}`)
                }
              }
              toast.info(`上传完成：${uploaded}/${files.length} 张背景`)
            })
          }}
        />
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-400" />
            <input
              className={cx(controlClass, 'pl-8')}
              placeholder="搜索背景"
              aria-label="搜索背景"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className={cx(selectClass, 'w-24 shrink-0')}
            aria-label="排序"
            value={sort}
            onChange={(e) => setSort(e.target.value as 'latest' | 'name')}
          >
            <option value="latest">最新</option>
            <option value="name">名字</option>
          </select>
        </div>
        {/* 当前生效范围：本聊天 / 全局 */}
        <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white text-[13px] dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/40">
          {stageBg?.bg && (
            <div className="flex h-10 items-center gap-2 px-3" title="模型用场景指令切换的背景，优先于本聊天和全局背景">
              <span className="w-14 shrink-0 text-zinc-500">舞台</span>
              <span className="min-w-0 flex-1 truncate font-medium">
                {list.find((b) => b.id === stageBg.backgroundId)?.name ?? (
                  <span className="font-normal text-zinc-400">「{stageBg.bg}」没有匹配的背景</span>
                )}
              </span>
            </div>
          )}
          {chatId && (
            <div className="flex h-10 items-center gap-2 px-3">
              <span className="w-14 shrink-0 text-zinc-500">本聊天</span>
              <span className="min-w-0 flex-1 truncate font-medium">
                {list.find((b) => b.id === chat?.backgroundId)?.name ?? (
                  <span className="font-normal text-zinc-400">跟随全局</span>
                )}
              </span>
              {chat?.backgroundId && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="-mr-1.5 h-7 px-2 text-xs"
                  disabled={busy}
                  onClick={() => void run(() => api.updateChat(chatId, { backgroundId: null }))}
                >
                  清除
                </Button>
              )}
            </div>
          )}
          <div className="flex h-10 items-center gap-2 px-3">
            <span className="w-14 shrink-0 text-zinc-500">全局</span>
            <span className="min-w-0 flex-1 truncate font-medium">
              {list.find((b) => b.id === globalId)?.name ?? <span className="font-normal text-zinc-400">无</span>}
            </span>
          </div>
        </div>
        {current && (
          <fieldset
            disabled={busy}
            className="space-y-2.5 rounded-xl border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-900 dark:bg-violet-950/30"
          >
            <div className="flex items-center gap-1">
              <p className="min-w-0 flex-1 truncate text-sm font-semibold">{current.name}</p>
              <IconButton
                label="重命名"
                onClick={() => {
                  setName(current.name)
                  setRenaming(true)
                }}
              >
                <EditIcon />
              </IconButton>
              <IconButton
                variant="danger"
                label="删除"
                onClick={() => {
                  if (confirm(`确定删除背景「${current.name}」？使用它的会话将跟随全局背景。`))
                    void run(async () => {
                      await api.deleteBackground(current.id)
                      setSelected(null)
                    })
                }}
              >
                <TrashIcon />
              </IconButton>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                size="sm"
                variant={chat?.backgroundId === current.id ? 'secondary' : 'primary'}
                disabled={!chat}
                onClick={() =>
                  chatId &&
                  void run(() =>
                    api.updateChat(chatId, { backgroundId: chat?.backgroundId === current.id ? null : current.id }),
                  )
                }
              >
                {chat?.backgroundId === current.id ? '取消本聊天' : '用于本聊天'}
              </Button>
              <Button
                size="sm"
                disabled={settings.isPending || settings.isError}
                onClick={() =>
                  void run(() => api.setBackgroundSettings({ globalId: globalId === current.id ? null : current.id }))
                }
              >
                {globalId === current.id ? '取消全局' : '设为全局'}
              </Button>
            </div>
          </fieldset>
        )}
        {backgrounds.isPending ? (
          <p className="text-sm text-zinc-500">加载中…</p>
        ) : backgrounds.isError ? (
          <p className="text-sm text-red-600">{errorMessage(backgrounds.error)}</p>
        ) : list.length === 0 ? (
          <p className="py-10 text-center text-sm text-zinc-400">还没有背景，点右上角「上传」</p>
        ) : filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-400">没有匹配的背景</p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {filtered.map((b) => (
              <button
                key={b.id}
                type="button"
                disabled={busy}
                aria-pressed={selected === b.id}
                onClick={() => setSelected(selected === b.id ? null : b.id)}
                className="group min-w-0 text-left"
              >
                <div
                  className={cx(
                    'relative overflow-hidden rounded-lg bg-zinc-100 ring-2 ring-offset-2 ring-offset-white transition-shadow dark:bg-zinc-800 dark:ring-offset-zinc-950',
                    selected === b.id
                      ? 'ring-violet-500'
                      : 'ring-transparent group-hover:ring-zinc-200 dark:group-hover:ring-zinc-700',
                  )}
                >
                  {b.mime.startsWith('video/') ? (
                    <video
                      src={b.thumbUrl}
                      muted
                      preload="metadata"
                      playsInline
                      className="aspect-video w-full object-cover"
                      aria-label={b.name}
                    />
                  ) : (
                    <img src={b.thumbUrl} alt={b.name} loading="lazy" className="aspect-video w-full object-cover" />
                  )}
                  <div className="absolute inset-x-1.5 top-1.5 flex flex-wrap gap-1 text-[10px] leading-4 font-medium text-white">
                    {chat?.backgroundId === b.id && (
                      <span className="rounded bg-violet-600/90 px-1.5 shadow-sm">本聊天</span>
                    )}
                    {globalId === b.id && <span className="rounded bg-zinc-900/75 px-1.5 shadow-sm">全局</span>}
                  </div>
                  <div className="absolute right-1.5 bottom-1.5 flex gap-1 text-[10px] leading-4 font-medium text-white">
                    {b.source === 'generated' && (
                      <span className="rounded bg-black/55 px-1.5 backdrop-blur-sm">AI</span>
                    )}
                    {b.animated && <span className="rounded bg-black/55 px-1.5 backdrop-blur-sm">动态</span>}
                  </div>
                </div>
                <p className="mt-1.5 truncate text-xs" title={b.name}>
                  {b.name}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>
      <Dialog open={importing} onClose={() => setImporting(false)} title="从网址添加背景">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              await api.importBackgroundUrl({
                url: url.trim(),
                ...(importName.trim() ? { name: importName.trim() } : {}),
              })
              setImporting(false)
              setUrl('')
              setImportName('')
              toast.info('背景已添加')
            })
          }}
        >
          <TextField label="背景网址（http/https）" value={url} onChange={setUrl} />
          <TextField label="名称（可选）" value={importName} onChange={setImportName} />
          <Button type="submit" variant="primary" disabled={busy || !url.trim()}>
            {busy ? '添加中…' : '添加'}
          </Button>
        </form>
      </Dialog>
      <Dialog open={renaming && !!current} onClose={() => setRenaming(false)} title="重命名背景">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (current && name.trim())
              void run(async () => {
                await api.renameBackground(current.id, name)
                setRenaming(false)
              })
          }}
        >
          <TextField label="背景名称" value={name} onChange={setName} />
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            保存
          </Button>
        </form>
      </Dialog>
    </div>
  )
}
