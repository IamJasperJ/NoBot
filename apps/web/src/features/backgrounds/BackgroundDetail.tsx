import type { BackgroundDTO, BackgroundFolderDTO, ChatDTO, StageState } from '@nobot/shared'
import { api } from '../../api/client'
import { useAddBackgroundsToFolder, useRemoveBackgroundsFromFolder, useUpdateBackgroundFolder } from '../../api/queries'
import { EditIcon, TrashIcon } from '../../components/icons'
import { Button, cx, IconButton, selectClass } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'

/** 当前生效的背景：固定的聊天背景 > 舞台 > 本聊天 > 全局 */
export function ActiveBackgrounds({
  list,
  chatId,
  chat,
  stageBg,
  globalId,
  busy,
  run,
}: {
  list: BackgroundDTO[]
  chatId: string | null
  chat: ChatDTO | undefined
  stageBg: StageState['scene'] | undefined
  globalId: string | null | undefined
  busy: boolean
  run: (action: () => Promise<unknown>) => Promise<void>
}) {
  const stageName = list.find((b) => b.id === stageBg?.backgroundId)?.name
  // 用户固定了本聊天背景：舞台背景被手动覆盖
  const overridden = !!chat?.backgroundPinned && !!chat.backgroundId
  return (
    <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white text-[13px] dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900/40">
      {stageBg?.bg && (
        <div className="flex min-h-10 items-center gap-2 px-3 py-1.5" title={t('模型用场景指令切换的背景')}>
          <span className="w-12 shrink-0 text-zinc-500">{t('舞台')}</span>
          <span className={cx('min-w-0 flex-1 truncate', overridden ? 'text-zinc-400 line-through' : 'font-medium')}>
            {stageName ?? (
              <span className="font-normal text-zinc-400">{t('「{scene}」没有匹配的背景', { scene: stageBg.bg })}</span>
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
              onClick={() => void run(() => api.updateChat(chatId, { backgroundId: null, backgroundPinned: false }))}
            >
              {t('清除')}
            </Button>
          )}
        </div>
      )}
      <div className="flex min-h-10 items-center gap-2 px-3 py-1.5">
        <span className="w-12 shrink-0 text-zinc-500">{t('全局')}</span>
        <span className="min-w-0 flex-1 truncate font-medium">
          {list.find((b) => b.id === globalId)?.name ?? <span className="font-normal text-zinc-400">{t('无')}</span>}
        </span>
      </div>
    </div>
  )
}

/** 选中一张背景后的详情卡：说明、用于本聊天 / 设为全局、文件夹、封面、设为公共 */
export function BackgroundDetail({
  current,
  chatId,
  chat,
  stageActive,
  globalId,
  settingsReady,
  folders,
  folder,
  busy,
  run,
  onEdit,
  onDeleted,
}: {
  current: BackgroundDTO
  chatId: string | null
  chat: ChatDTO | undefined
  /** 舞台正在管背景（模型用场景指令切换过） */
  stageActive: boolean
  globalId: string | null | undefined
  settingsReady: boolean
  folders: BackgroundFolderDTO[]
  /** 当前打开的文件夹 */
  folder: BackgroundFolderDTO | null
  busy: boolean
  run: (action: () => Promise<unknown>) => Promise<void>
  onEdit: () => void
  onDeleted: () => void
}) {
  const updateFolder = useUpdateBackgroundFolder()
  const addToFolder = useAddBackgroundsToFolder()
  const removeFromFolder = useRemoveBackgroundsFromFolder()
  const mutateOpts = { onError: (e: unknown) => toast.error(errorMessage(e)) }
  return (
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
        <IconButton label={t('编辑名字和描述')} onClick={onEdit}>
          <EditIcon />
        </IconButton>
        <IconButton
          variant="danger"
          label={t('删除')}
          onClick={() => {
            if (confirm(t('确定删除背景「{name}」？使用它的会话将跟随全局背景。', { name: current.name })))
              void run(async () => {
                await api.deleteBackground(current.id)
                onDeleted()
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
            const pin = stageActive
            void run(async () => {
              await api.updateChat(chatId, { backgroundId: current.id, backgroundPinned: pin })
              if (pin)
                toast.info(t('已用于本聊天并固定：舞台换场景时不再切换背景。在「舞台」一行点「跟随舞台」可以恢复'))
            })
          }}
        >
          {chat?.backgroundId === current.id ? t('取消本聊天') : t('用于本聊天')}
        </Button>
        <Button
          size="sm"
          className="min-w-0"
          disabled={!settingsReady}
          onClick={() =>
            void run(() => api.setBackgroundSettings({ globalId: globalId === current.id ? null : current.id }))
          }
        >
          {globalId === current.id ? t('取消全局') : t('设为全局')}
        </Button>
        <select
          className={cx(selectClass, 'col-span-2 h-8 min-w-0 text-xs')}
          aria-label={t('加入文件夹')}
          value=""
          disabled={!folders.length}
          onChange={(e) => {
            const id = e.target.value
            if (!id) return
            const inside = current.folderIds.includes(id)
            ;(inside ? removeFromFolder : addToFolder).mutate({ folderId: id, backgroundIds: [current.id] }, mutateOpts)
          }}
        >
          <option value="">
            {folders.length
              ? current.folderIds.length
                ? t('所在文件夹：{names}', {
                    names: folders
                      .filter((f) => current.folderIds.includes(f.id))
                      .map((f) => f.name)
                      .join('、'),
                  })
                : t('加入文件夹…')
              : t('还没有文件夹')}
          </option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {current.folderIds.includes(f.id) ? `✓ ${f.name}` : f.name}
            </option>
          ))}
        </select>
        {folder && (
          <Button
            size="sm"
            variant="ghost"
            className="col-span-2 min-w-0"
            disabled={folder.coverBackgroundId === current.id}
            onClick={() => updateFolder.mutate({ id: folder.id, input: { coverBackgroundId: current.id } }, mutateOpts)}
          >
            {folder.coverBackgroundId === current.id ? t('已是文件夹封面') : t('设为文件夹封面')}
          </Button>
        )}
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
  )
}
