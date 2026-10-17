import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { api } from '../../api/client'
import { keys, useAutoBackground, useBackgroundSettings, useBackgrounds, useChatPages } from '../../api/queries'
import { TextAreaField, TextField } from '../../components/form'
import { EditIcon, LinkIcon, SearchIcon, TrashIcon, UploadIcon, WandIcon } from '../../components/icons'
import { Button, controlClass, cx, Dialog, IconButton, selectClass } from '../../components/ui'
import { getLanguage, t } from '../../i18n'
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
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [scope, setScope] = useState<'usable' | 'all'>('usable')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'latest' | 'name'>('latest')
  const [importing, setImporting] = useState(false)
  const [url, setUrl] = useState('')
  const [importName, setImportName] = useState('')
  const list = backgrounds.data ?? []
  const keyword = search.trim().toLocaleLowerCase()
  const filtered = list
    // 「本会话可用」= 公共背景 + 本会话生成的，和舞台、自动选择的范围一致
    .filter((b) => !chatId || scope === 'all' || b.chatId === null || b.chatId === chatId)
    .filter((b) => `${b.name} ${b.description}`.toLocaleLowerCase().includes(keyword))
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name, getLanguage() === 'en' ? 'en-US' : 'zh-CN')
        : b.createdAt - a.createdAt || b.id.localeCompare(a.id),
    )
  const current = list.find((b) => b.id === selected)
  const globalId = settings.data?.globalId
  const stageName = list.find((b) => b.id === stageBg?.backgroundId)?.name
  // 用户固定了本聊天背景：舞台背景被手动覆盖
  const overridden = !!chat?.backgroundPinned && !!chat.backgroundId
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
        <h1 className="mr-auto font-semibold">{t('背景')}</h1>
        {chatId && (
          <IconButton
            label={auto.isPending ? t('正在让模型挑选…') : t('自动选择：让模型挑一张最适合当前场景的背景')}
            disabled={busy || auto.isPending}
            onClick={() => {
              auto.mutate(chatId, {
                onSuccess: ({ background }) => toast.info(t('已选择：{name}', { name: background.name })),
                onError: (error) => toast.error(errorMessage(error)),
              })
            }}
          >
            <WandIcon className={auto.isPending ? 'animate-pulse' : ''} />
          </IconButton>
        )}
        <IconButton label={t('从网址添加')} disabled={busy} onClick={() => setImporting(true)}>
          <LinkIcon />
        </IconButton>
        <Button size="sm" variant="primary" className="ml-1" disabled={busy} onClick={() => input.current?.click()}>
          <UploadIcon />
          {busy ? t('处理中…') : t('上传')}
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
              toast.info(t('上传完成：{uploaded}/{total} 张背景', { uploaded, total: files.length }))
            })
          }}
        />
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <div className="relative min-w-0">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-zinc-400" />
          <input
            className={cx(controlClass, 'pl-8')}
            placeholder={t('搜索名字或描述')}
            aria-label={t('搜索背景')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          {chatId ? (
            <div className="flex min-w-0 flex-1 gap-1 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
              {(
                [
                  ['usable', t('本会话可用')],
                  ['all', t('全部')],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={scope === value}
                  title={
                    value === 'usable'
                      ? t('公共背景 + 本会话生成的背景，舞台和自动选择只在这里面挑')
                      : t('包括其他会话生成的背景')
                  }
                  onClick={() => setScope(value)}
                  className={cx(
                    'h-7 flex-1 truncate rounded-md px-2 text-xs font-medium',
                    scope === value ? 'bg-white shadow-sm dark:bg-zinc-950' : 'text-zinc-500',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : (
            <span className="flex-1" />
          )}
          <select
            className={cx(selectClass, 'h-8 w-20 shrink-0 text-xs')}
            aria-label={t('排序')}
            value={sort}
            onChange={(e) => setSort(e.target.value as 'latest' | 'name')}
          >
            <option value="latest">{t('最新')}</option>
            <option value="name">{t('名字')}</option>
          </select>
        </div>

        {/* 当前生效的背景：固定的聊天背景 > 舞台 > 本聊天 > 全局 */}
        <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white text-[13px] dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/40">
          {stageBg?.bg && (
            <div className="flex min-h-10 items-center gap-2 px-3 py-1.5" title={t('模型用场景指令切换的背景')}>
              <span className="w-12 shrink-0 text-zinc-500">{t('舞台')}</span>
              <span
                className={cx('min-w-0 flex-1 truncate', overridden ? 'text-zinc-400 line-through' : 'font-medium')}
              >
                {stageName ?? (
                  <span className="font-normal text-zinc-400">
                    {t('「{scene}」没有匹配的背景', { scene: stageBg.bg })}
                  </span>
                )}
              </span>
              {overridden && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="-mr-1.5 h-7 shrink-0 px-2 text-xs"
                  title={t('取消固定，背景重新跟随舞台切换')}
                  disabled={busy}
                  onClick={() => chatId && void run(() => api.updateChat(chatId, { backgroundPinned: false }))}
                >
                  {t('跟随舞台')}
                </Button>
              )}
            </div>
          )}
          {chatId && (
            <div className="flex min-h-10 items-center gap-2 px-3 py-1.5">
              <span className="w-12 shrink-0 text-zinc-500">{t('本聊天')}</span>
              <span className="min-w-0 flex-1 truncate font-medium">
                {list.find((b) => b.id === chat?.backgroundId)?.name ?? (
                  <span className="font-normal text-zinc-400">{t('跟随全局')}</span>
                )}
              </span>
              {chat?.backgroundId && stageBg?.bg && (
                <button
                  type="button"
                  aria-pressed={chat.backgroundPinned}
                  disabled={busy}
                  title={
                    chat.backgroundPinned
                      ? t('已固定：舞台换场景时不切换背景。点一下取消固定')
                      : t('固定后舞台换场景时不切换背景（手动覆盖模型选的场景）')
                  }
                  onClick={() => void run(() => api.updateChat(chatId, { backgroundPinned: !chat.backgroundPinned }))}
                  className={cx(
                    'h-6 shrink-0 rounded-md border px-1.5 text-[11px] font-medium transition-colors',
                    chat.backgroundPinned
                      ? 'border-violet-300 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/60 dark:text-violet-300'
                      : 'border-zinc-200 text-zinc-500 hover:text-zinc-800 dark:border-zinc-700',
                  )}
                >
                  {chat.backgroundPinned ? t('已固定') : t('固定')}
                </button>
              )}
              {chat?.backgroundId && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="-mr-1.5 h-7 shrink-0 px-2 text-xs"
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.updateChat(chatId, { backgroundId: null, backgroundPinned: false }))
                  }
                >
                  {t('清除')}
                </Button>
              )}
            </div>
          )}
          <div className="flex min-h-10 items-center gap-2 px-3 py-1.5">
            <span className="w-12 shrink-0 text-zinc-500">{t('全局')}</span>
            <span className="min-w-0 flex-1 truncate font-medium">
              {list.find((b) => b.id === globalId)?.name ?? (
                <span className="font-normal text-zinc-400">{t('无')}</span>
              )}
            </span>
          </div>
        </div>

        {current && (
          // fieldset 默认 min-width: min-content，不加 min-w-0 会被长名字撑出面板
          <fieldset
            disabled={busy}
            className="min-w-0 space-y-2.5 rounded-xl border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-900 dark:bg-violet-950/30"
          >
            <div className="flex min-w-0 items-start gap-1">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold" title={current.name}>
                  {current.name}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {current.chatId === null
                    ? t('公共背景')
                    : current.chatId === chatId
                      ? t('本会话生成')
                      : t('其他会话生成（本会话的舞台不会选到它）')}
                </p>
              </div>
              <IconButton
                label={t('编辑名字和描述')}
                onClick={() => {
                  setName(current.name)
                  setDescription(current.description)
                  setEditing(true)
                }}
              >
                <EditIcon />
              </IconButton>
              <IconButton
                variant="danger"
                label={t('删除')}
                onClick={() => {
                  if (confirm(t('确定删除背景「{name}」？使用它的会话将跟随全局背景。', { name: current.name })))
                    void run(async () => {
                      await api.deleteBackground(current.id)
                      setSelected(null)
                    })
                }}
              >
                <TrashIcon />
              </IconButton>
            </div>
            <p
              className={cx(
                'text-xs leading-relaxed',
                current.description ? 'text-zinc-600 dark:text-zinc-300' : 'text-zinc-400',
              )}
            >
              {current.description || t('没有描述。模型挑背景时会看到名字和描述，点右上角编辑补上。')}
            </p>
            <div className="grid min-w-0 grid-cols-2 gap-2">
              <Button
                size="sm"
                className="min-w-0"
                variant={chat?.backgroundId === current.id ? 'secondary' : 'primary'}
                disabled={!chat}
                onClick={() => {
                  if (!chatId) return
                  if (chat?.backgroundId === current.id) {
                    void run(() => api.updateChat(chatId, { backgroundId: null, backgroundPinned: false }))
                    return
                  }
                  // 舞台在管背景时，手动选的背景要固定，否则会被舞台盖住、看起来像没生效
                  const pin = !!stageBg?.bg
                  void run(async () => {
                    await api.updateChat(chatId, { backgroundId: current.id, backgroundPinned: pin })
                    if (pin)
                      toast.info(
                        t('已用于本聊天并固定：舞台换场景时不再切换背景。在「舞台」一行点「跟随舞台」可以恢复'),
                      )
                  })
                }}
              >
                {chat?.backgroundId === current.id ? t('取消本聊天') : t('用于本聊天')}
              </Button>
              <Button
                size="sm"
                className="min-w-0"
                disabled={settings.isPending || settings.isError}
                onClick={() =>
                  void run(() => api.setBackgroundSettings({ globalId: globalId === current.id ? null : current.id }))
                }
              >
                {globalId === current.id ? t('取消全局') : t('设为全局')}
              </Button>
              {current.chatId !== null && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="col-span-2 min-w-0"
                  title={t('设为公共后，所有会话的舞台和自动选择都能选到它')}
                  onClick={() => void run(() => api.updateBackground(current.id, { chatId: null }))}
                >
                  {t('设为公共背景')}
                </Button>
              )}
            </div>
          </fieldset>
        )}

        {backgrounds.isPending ? (
          <p className="text-sm text-zinc-500">{t('加载中…')}</p>
        ) : backgrounds.isError ? (
          <p className="text-sm text-red-600">{errorMessage(backgrounds.error)}</p>
        ) : list.length === 0 ? (
          <p className="py-10 text-center text-sm text-zinc-400">{t('还没有背景，点右上角「上传」')}</p>
        ) : filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-400">{t('没有匹配的背景')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {filtered.map((b) => {
              const foreign = !!chatId && b.chatId !== null && b.chatId !== chatId
              return (
                <button
                  key={b.id}
                  type="button"
                  disabled={busy}
                  aria-pressed={selected === b.id}
                  title={b.description ? `${b.name}\n${b.description}` : b.name}
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
                    <div className="absolute inset-x-1.5 top-1.5 flex flex-wrap gap-1 text-[10px] leading-4 font-medium text-white">
                      {chat?.backgroundId === b.id && (
                        <span className="rounded bg-violet-600/90 px-1.5 shadow-sm">{t('本聊天')}</span>
                      )}
                      {stageBg?.backgroundId === b.id && (
                        <span className="rounded bg-emerald-600/90 px-1.5 shadow-sm">{t('舞台')}</span>
                      )}
                      {globalId === b.id && (
                        <span className="rounded bg-zinc-900/75 px-1.5 shadow-sm">{t('全局')}</span>
                      )}
                    </div>
                    <div className="absolute right-1.5 bottom-1.5 left-1.5 flex justify-end gap-1 text-[10px] leading-4 font-medium text-white">
                      {foreign && (
                        <span className="mr-auto rounded bg-black/55 px-1.5 backdrop-blur-sm">{t('其他会话')}</span>
                      )}
                      {b.chatId !== null && b.chatId === chatId && (
                        <span className="mr-auto rounded bg-black/55 px-1.5 backdrop-blur-sm">{t('本会话')}</span>
                      )}
                      {b.source === 'generated' && (
                        <span className="rounded bg-black/55 px-1.5 backdrop-blur-sm">AI</span>
                      )}
                      {b.animated && <span className="rounded bg-black/55 px-1.5 backdrop-blur-sm">{t('动态')}</span>}
                    </div>
                  </div>
                  <p className="mt-1.5 truncate text-xs" title={b.name}>
                    {b.name}
                  </p>
                </button>
              )
            })}
          </div>
        )}
      </div>
      <Dialog open={importing} onClose={() => setImporting(false)} title={t('从网址添加背景')}>
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
              toast.info(t('背景已添加'))
            })
          }}
        >
          <TextField label={t('背景网址（http/https）')} value={url} onChange={setUrl} />
          <TextField label={t('名称（可选）')} value={importName} onChange={setImportName} />
          <Button type="submit" variant="primary" disabled={busy || !url.trim()}>
            {busy ? t('添加中…') : t('添加')}
          </Button>
        </form>
      </Dialog>
      <Dialog open={editing && !!current} onClose={() => setEditing(false)} title={t('编辑背景')}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (current && name.trim())
              void run(async () => {
                await api.updateBackground(current.id, { name: name.trim(), description: description.trim() })
                setEditing(false)
              })
          }}
        >
          <TextField
            label={t('名字')}
            hint={t('模型用场景指令换背景时按名字匹配，写地点最好用（比如「黄昏的酒馆」）')}
            value={name}
            onChange={setName}
          />
          <TextAreaField
            label={t('描述')}
            hint={t('一句话描述画面：地点、时间、氛围。会和名字一起出现在给模型的背景清单里')}
            rows={3}
            value={description}
            onChange={setDescription}
          />
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            {t('保存')}
          </Button>
        </form>
      </Dialog>
    </div>
  )
}
