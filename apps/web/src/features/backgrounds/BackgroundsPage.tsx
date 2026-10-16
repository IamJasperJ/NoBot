import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { api } from '../../api/client'
import { keys, useAutoBackground, useBackgroundSettings, useBackgrounds, useChatPages } from '../../api/queries'
import { SelectField, TextField } from '../../components/form'
import { UploadIcon } from '../../components/icons'
import { Button, cx, Dialog } from '../../components/ui'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'

export function BackgroundsPage() {
  const auto = useAutoBackground()
  const backgrounds = useBackgrounds()
  const settings = useBackgroundSettings()
  const chatId = useUi((s) => s.chatId)
  const pages = useChatPages(chatId)
  const chat = pages.data?.pages[0]?.chat
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
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 py-2 border-b border-zinc-200 px-3 dark:border-zinc-800">
        <h1 className="mr-auto font-semibold">背景</h1>
        {chatId && (
          <Button
            disabled={busy || auto.isPending}
            onClick={() => {
              auto.mutate(chatId, {
                onSuccess: ({ background }) => toast.info(`已选择：${background.name}`),
                onError: (error) => toast.error(errorMessage(error)),
              })
            }}
          >
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="m4 20 13-13 3 3L7 23zM5 3v4M3 5h4M17 1v4M15 3h4M21 15v4M19 17h4" />
            </svg>
            {auto.isPending ? '选择中…' : '自动选择'}
          </Button>
        )}
        <Button disabled={busy} onClick={() => setImporting(true)}>
          从网址添加
        </Button>
        <Button disabled={busy} onClick={() => input.current?.click()}>
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
        <div className="flex items-end gap-2">
          <TextField label="搜索背景" value={search} onChange={setSearch} />
          <SelectField
            label="排序"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'latest', label: '最新' },
              { value: 'name', label: '名字' },
            ]}
          />
        </div>
        <div className="space-y-2 rounded-lg bg-zinc-100 p-2 text-xs dark:bg-zinc-900">
          {chatId && (
            <div className="flex items-center gap-1">
              <span className="min-w-0 flex-1 break-words">
                当前聊天背景：{list.find((b) => b.id === chat?.backgroundId)?.name ?? '跟随全局'}
              </span>
              <Button
                disabled={busy || !chat?.backgroundId}
                onClick={() => void run(() => api.updateChat(chatId, { backgroundId: null }))}
              >
                清除
              </Button>
            </div>
          )}
          <div className="break-words">全局背景：{list.find((b) => b.id === globalId)?.name ?? '无'}</div>
        </div>
        {current && (
          <fieldset
            disabled={busy}
            className="space-y-2 rounded-lg border border-violet-200 p-2 dark:border-violet-900"
          >
            <p className="truncate text-sm font-medium">{current.name}</p>
            <Button
              className="w-full"
              disabled={settings.isPending || settings.isError}
              onClick={() =>
                void run(() => api.setBackgroundSettings({ globalId: globalId === current.id ? null : current.id }))
              }
            >
              {globalId === current.id ? '取消全局' : '设为全局背景'}
            </Button>
            <Button
              className="w-full"
              disabled={!chat}
              onClick={() =>
                chatId &&
                void run(() =>
                  api.updateChat(chatId, { backgroundId: chat?.backgroundId === current.id ? null : current.id }),
                )
              }
            >
              {chat?.backgroundId === current.id ? '取消本聊天背景' : '设为当前聊天背景'}
            </Button>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  setName(current.name)
                  setRenaming(true)
                }}
              >
                重命名
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (confirm(`确定删除背景「${current.name}」？使用它的会话将跟随全局背景。`))
                    void run(async () => {
                      await api.deleteBackground(current.id)
                      setSelected(null)
                    })
                }}
              >
                删除
              </Button>
            </div>
          </fieldset>
        )}
        {backgrounds.isPending ? (
          <p className="text-sm text-zinc-500">加载中…</p>
        ) : backgrounds.isError ? (
          <p className="text-sm text-red-600">{errorMessage(backgrounds.error)}</p>
        ) : list.length === 0 ? (
          <p className="py-6 text-sm text-zinc-500">还没有背景，点右上角上传</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-zinc-500">没有匹配的背景</p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {filtered.map((b) => (
              <button
                key={b.id}
                type="button"
                disabled={busy}
                aria-pressed={selected === b.id}
                onClick={() => setSelected(selected === b.id ? null : b.id)}
                className="min-w-0 text-left"
              >
                <div
                  className={cx(
                    'relative overflow-hidden rounded-lg ring-2 ring-offset-2 ring-offset-white dark:ring-offset-zinc-950',
                    selected === b.id ? 'ring-violet-500' : 'ring-transparent',
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
                  {b.animated && (
                    <span className="absolute right-1 bottom-1 rounded bg-zinc-900/80 px-1 text-[10px] text-white">
                      动态
                    </span>
                  )}
                  <div className="absolute inset-x-1 top-1 flex flex-wrap gap-1 text-[10px] text-white">
                    {globalId === b.id && <span className="rounded bg-violet-700 px-1">全局</span>}
                    {chat?.backgroundId === b.id && <span className="rounded bg-blue-700 px-1">本聊天</span>}
                    {b.source === 'generated' && <span className="rounded bg-zinc-900/80 px-1">AI</span>}
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
