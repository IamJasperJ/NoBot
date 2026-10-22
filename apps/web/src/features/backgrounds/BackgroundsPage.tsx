import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { api } from '../../api/client'
import {
  keys,
  useAddBackgroundsToFolder,
  useAiNameBackgrounds,
  useAutoBackground,
  useBackgroundFolders,
  useBackgroundSettings,
  useBackgrounds,
  useBatchDeleteBackgrounds,
  useChatPages,
  useDeleteBackgroundFolder,
  useRemoveBackgroundsFromFolder,
} from '../../api/queries'
import {
  ChevronLeftIcon,
  EditIcon,
  LinkIcon,
  ListCheckIcon,
  SearchIcon,
  TrashIcon,
  UploadIcon,
  WandIcon,
} from '../../components/icons'
import { Menu, MenuEntry } from '../../components/menu'
import { Button, controlClass, cx, IconButton, selectClass } from '../../components/ui'
import { getLanguage, t } from '../../i18n'
import { useAppearance } from '../../stores/appearance'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { ActiveBackgrounds, BackgroundDetail } from './BackgroundDetail'
import { EditBackgroundDialog, FolderDialog, ImportUrlDialog, reportAiName } from './BackgroundDialogs'
import { BackgroundTile, FolderGrid, SelectionBar, useColumns } from './BackgroundGrid'

/** 两到三个选项的分段切换 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: readonly (readonly [T, string, string?])[]
  onChange: (value: T) => void
}) {
  return (
    <div className="flex min-w-0 flex-1 gap-1 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
      {options.map(([option, label, title]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          title={title}
          onClick={() => onChange(option)}
          className={cx(
            'h-7 flex-1 truncate rounded-md px-2 text-xs font-medium',
            value === option ? 'bg-white shadow-sm dark:bg-zinc-950' : 'text-zinc-500',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

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
  const [scope, setScope] = useState<'usable' | 'all'>('usable')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'latest' | 'name'>('latest')
  const [importing, setImporting] = useState(false)
  // 「全部 / 文件夹」视图；folderId 不为空表示进入了某个文件夹
  const [view, setView] = useState<'all' | 'folders'>('all')
  const [folderId, setFolderId] = useState<string | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [folderDialog, setFolderDialog] = useState<{ id: string | null; name: string } | null>(null)
  const folders = useBackgroundFolders()
  const deleteFolder = useDeleteBackgroundFolder()
  const addToFolder = useAddBackgroundsToFolder()
  const removeFromFolder = useRemoveBackgroundsFromFolder()
  const batchDelete = useBatchDeleteBackgrounds()
  const aiName = useAiNameBackgrounds()
  const columnsBase = useAppearance((s) => s.backgroundColumns)
  const setAppearance = useAppearance((s) => s.set)
  const gridRef = useRef<HTMLDivElement>(null)
  const columns = useColumns(gridRef, columnsBase)
  const folder = folders.data?.find((f) => f.id === folderId) ?? null
  const showFolderList = view === 'folders' && !folder
  const list = backgrounds.data ?? []
  const keyword = search.trim().toLocaleLowerCase()
  const filtered = list
    // 「本会话可用」= 公共背景 + 本会话生成的，和舞台、自动选择的范围一致
    .filter((b) => !chatId || scope === 'all' || b.chatId === null || b.chatId === chatId)
    .filter((b) => !folder || b.folderIds.includes(folder.id))
    .filter((b) => `${b.name} ${b.description}`.toLocaleLowerCase().includes(keyword))
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name, getLanguage() === 'en' ? 'en-US' : 'zh-CN')
        : b.createdAt - a.createdAt || b.id.localeCompare(a.id),
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
  const stopSelecting = () => {
    setSelecting(false)
    setPicked([])
  }
  const togglePick = (id: string) =>
    setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]))
  const mutateOpts = { onError: (e: unknown) => toast.error(errorMessage(e)) }
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
  const upload = (files: File[]) =>
    run(async () => {
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
        <IconButton
          label={selecting ? t('退出选择') : t('选择多张（批量删除、加入文件夹）')}
          aria-pressed={selecting}
          disabled={busy}
          className={selecting ? 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300' : ''}
          onClick={() => {
            if (selecting) stopSelecting()
            else {
              setSelecting(true)
              setSelected(null)
            }
          }}
        >
          <ListCheckIcon />
        </IconButton>
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
            if (files.length) void upload(files)
          }}
        />
      </header>
      <div ref={gridRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
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
            <Segmented
              value={scope}
              onChange={setScope}
              options={[
                ['usable', t('本会话可用'), t('公共背景 + 本会话生成的背景，舞台和自动选择只在这里面挑')],
                ['all', t('全部'), t('包括其他会话生成的背景')],
              ]}
            />
          ) : (
            <span className="flex-1" />
          )}
          <div className="flex shrink-0 items-center rounded-lg border border-zinc-200 dark:border-zinc-700">
            <button
              type="button"
              className="flex size-8 items-center justify-center text-zinc-500 hover:text-zinc-900 disabled:opacity-40 dark:hover:text-zinc-100"
              title={t('每行少放几张')}
              aria-label={t('每行少放几张')}
              disabled={columnsBase <= 2}
              onClick={() => setAppearance({ backgroundColumns: columnsBase - 1 })}
            >
              −
            </button>
            <button
              type="button"
              className="flex size-8 items-center justify-center text-zinc-500 hover:text-zinc-900 disabled:opacity-40 dark:hover:text-zinc-100"
              title={t('每行多放几张')}
              aria-label={t('每行多放几张')}
              disabled={columnsBase >= 6}
              onClick={() => setAppearance({ backgroundColumns: columnsBase + 1 })}
            >
              +
            </button>
          </div>
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

        <Segmented
          value={view}
          onChange={(value) => {
            setView(value)
            setFolderId(null)
          }}
          options={[
            ['all', t('全部背景')],
            ['folders', t('文件夹')],
          ]}
        />

        <ActiveBackgrounds
          list={list}
          chatId={chatId}
          chat={chat}
          stageBg={stageBg}
          globalId={globalId}
          busy={busy}
          run={run}
        />

        {current && (
          <BackgroundDetail
            current={current}
            chatId={chatId}
            chat={chat}
            stageActive={!!stageBg?.bg}
            globalId={globalId}
            settingsReady={!settings.isPending && !settings.isError}
            folders={folders.data ?? []}
            folder={folder}
            busy={busy}
            run={run}
            onEdit={() => setEditing(true)}
            onDeleted={() => setSelected(null)}
          />
        )}

        {folder && (
          <div className="flex min-w-0 items-center gap-1">
            <IconButton label={t('返回文件夹列表')} onClick={() => setFolderId(null)}>
              <ChevronLeftIcon />
            </IconButton>
            <button type="button" className="text-sm text-zinc-500 hover:underline" onClick={() => setFolderId(null)}>
              {t('文件夹')}
            </button>
            <span className="text-zinc-300">/</span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{folder.name}</span>
            <Menu>
              <MenuEntry icon={<EditIcon />} onClick={() => setFolderDialog({ id: folder.id, name: folder.name })}>
                {t('重命名')}
              </MenuEntry>
              <MenuEntry
                icon={<TrashIcon />}
                danger
                onClick={() => {
                  if (confirm(t('删除文件夹「{name}」？里面的背景不会被删除。', { name: folder.name })))
                    deleteFolder.mutate(folder.id, { ...mutateOpts, onSuccess: () => setFolderId(null) })
                }}
              >
                {t('删除文件夹')}
              </MenuEntry>
            </Menu>
          </div>
        )}

        {showFolderList ? (
          <FolderGrid
            folders={folders.data ?? []}
            backgrounds={list}
            columns={columns}
            onOpen={(id) => {
              setFolderId(id)
              setSelected(null)
            }}
            onCreate={() => setFolderDialog({ id: null, name: '' })}
          />
        ) : backgrounds.isPending ? (
          <p className="text-sm text-zinc-500">{t('加载中…')}</p>
        ) : backgrounds.isError ? (
          <p className="text-sm text-red-600">{errorMessage(backgrounds.error)}</p>
        ) : list.length === 0 ? (
          <p className="py-10 text-center text-sm text-zinc-400">{t('还没有背景，点右上角「上传」')}</p>
        ) : filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-400">
            {folder ? t('文件夹是空的。在背景详情里选「加入文件夹」，或者多选后批量加入') : t('没有匹配的背景')}
          </p>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
            {filtered.map((b) => (
              <BackgroundTile
                key={b.id}
                background={b}
                chatId={chatId}
                active={selecting ? picked.includes(b.id) : selected === b.id}
                disabled={busy}
                selecting={selecting}
                marks={{
                  chat: chat?.backgroundId === b.id,
                  stage: stageBg?.backgroundId === b.id,
                  global: globalId === b.id,
                }}
                onClick={() => (selecting ? togglePick(b.id) : setSelected(selected === b.id ? null : b.id))}
              />
            ))}
          </div>
        )}
      </div>
      {selecting && (
        <SelectionBar
          count={picked.length}
          folders={folders.data ?? []}
          inFolder={folder}
          busy={batchDelete.isPending || addToFolder.isPending || removeFromFolder.isPending || aiName.isPending}
          naming={aiName.isPending}
          onAiName={() => aiName.mutate({ ids: picked }, { ...mutateOpts, onSuccess: reportAiName })}
          onAll={() => setPicked(picked.length === filtered.length ? [] : filtered.map((b) => b.id))}
          allPicked={picked.length > 0 && picked.length === filtered.length}
          onDelete={() => {
            if (confirm(t('删除选中的 {count} 张背景？使用它们的会话将跟随全局背景。', { count: picked.length })))
              batchDelete.mutate(picked, {
                ...mutateOpts,
                onSuccess: () => {
                  toast.info(t('已删除 {count} 张背景', { count: picked.length }))
                  setPicked([])
                },
              })
          }}
          onAdd={(id) =>
            addToFolder.mutate(
              { folderId: id, backgroundIds: picked },
              { ...mutateOpts, onSuccess: () => toast.info(t('已加入文件夹')) },
            )
          }
          onRemove={() =>
            folder &&
            removeFromFolder.mutate(
              { folderId: folder.id, backgroundIds: picked },
              { ...mutateOpts, onSuccess: () => setPicked([]) },
            )
          }
          onDone={stopSelecting}
        />
      )}
      <FolderDialog value={folderDialog} onChange={setFolderDialog} onClose={() => setFolderDialog(null)} />
      <ImportUrlDialog open={importing} busy={busy} run={run} onClose={() => setImporting(false)} />
      {editing && current && (
        <EditBackgroundDialog current={current} busy={busy} run={run} onClose={() => setEditing(false)} />
      )}
    </div>
  )
}
