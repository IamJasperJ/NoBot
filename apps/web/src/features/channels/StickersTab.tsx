import { useState } from 'react'
import {
  type ChannelAccountDTO,
  type ChannelStickerDTO,
  type ChannelStickerGroupDTO,
  useAddStickerSet,
  useChannelStickers,
  useDeleteSticker,
  useRefreshQqFaces,
  useUpdateSticker,
} from '../../api/channels'
import { useCharacters } from '../../api/queries'
import { Toggle } from '../../components/form'
import { RefreshIcon, TrashIcon } from '../../components/icons'
import { Avatar, Button, badgeClass, controlClass, cx, IconButton } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'

const sourceLabel = (source: ChannelStickerGroupDTO['source']) =>
  ({
    'telegram-set': t('贴纸包'),
    'telegram-learned': t('聊天里学到的'),
    'qq-face': t('QQ 小黄脸'),
    'qq-collected': t('bot 收藏的表情'),
    'qq-learned': t('聊天里学到的'),
  })[source]

/**
 * 表情包管理：只管理平台里已有的表情引用（不在服务器存图），
 * 角色用 send_sticker 工具发送；这里可以开关整组 / 单个，以及限定给某些角色专用
 */
export function StickersTab({ account }: { account: ChannelAccountDTO }) {
  const stickers = useChannelStickers(account.id)
  const add = useAddStickerSet()
  const refresh = useRefreshQqFaces()
  const [name, setName] = useState('')
  const groups = stickers.data?.groups ?? []
  const telegram = account.provider === 'telegram'
  const onError = (e: unknown) => toast.error(errorMessage(e))
  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-500 dark:bg-zinc-800/50 dark:text-zinc-400">
        {telegram
          ? t('角色会按心情从这些贴纸里挑一个发出去。贴纸都留在 Telegram，NoBot 只记下引用和含义（emoji）。')
          : t('角色会按心情从这些表情里挑一个发出去。表情都留在 QQ，NoBot 只记下引用和含义。')}{' '}
        {t('发送频率和是否自动学习在「行为」页签里设置。')}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {telegram ? (
          <form
            className="flex min-w-0 flex-1 gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (!name.trim()) return
              add.mutate(
                { accountId: account.id, name: name.trim() },
                {
                  onSuccess: () => {
                    setName('')
                    toast.info(t('已添加'))
                  },
                  onError,
                },
              )
            }}
          >
            <input
              className={cx(controlClass, 'min-w-0 flex-1')}
              placeholder={t('贴纸包链接或名称，例如 https://t.me/addstickers/xxx')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button variant="primary" type="submit" disabled={!name.trim() || add.isPending}>
              {t('添加贴纸包')}
            </Button>
          </form>
        ) : (
          <Button
            disabled={account.status !== 'online' || refresh.isPending}
            title={account.status !== 'online' ? t('bot 在线时才能读取收藏') : undefined}
            onClick={() => refresh.mutate(account.id, { onSuccess: () => toast.info(t('已刷新')), onError })}
          >
            <RefreshIcon />
            {t('刷新收藏的表情')}
          </Button>
        )}
        <span className="ml-auto text-xs text-zinc-500">{t('共 {n} 个', { n: stickers.data?.count ?? 0 })}</span>
      </div>
      {stickers.isLoading && <div className="py-6 text-center text-sm text-zinc-500">{t('加载中…')}</div>}
      {!stickers.isLoading && groups.length === 0 && (
        <div className="rounded-xl border border-dashed border-zinc-200 py-8 text-center text-sm text-zinc-500 dark:border-zinc-800">
          {telegram
            ? t('还没有贴纸。添加一个贴纸包，或在群里 / 私聊里发几张贴纸让它学。')
            : t('还没有表情。刷新 bot 收藏的表情，或在群里发几个表情让它学。')}
        </div>
      )}
      <div className="space-y-2">
        {groups.map((g) => (
          <GroupCard key={g.id} account={account} group={g} />
        ))}
      </div>
    </div>
  )
}

function GroupCard({ account, group }: { account: ChannelAccountDTO; group: ChannelStickerGroupDTO }) {
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const update = useUpdateSticker()
  const remove = useDeleteSticker()
  const characters = useCharacters().data ?? []
  const onError = (e: unknown) => toast.error(errorMessage(e))
  const patchGroup = (patch: { enabled?: boolean; characters?: string[] }) =>
    update.mutate({ accountId: account.id, id: group.id, kind: 'sets', patch }, { onError })
  const exclusive = characters.filter((c) => group.characters.includes(c.id))
  // 内置小黄脸是代码里的静态表，删了也会回来，只给开关
  const deletable = group.source !== 'qq-face'
  return (
    <section className="rounded-xl border border-zinc-200 dark:border-zinc-800">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen(!open)}
        >
          <span className={cx('text-xs text-zinc-400 transition-transform', open && 'rotate-90')}>▶</span>
          <span className="truncate text-[13px] font-medium">{group.title || group.name}</span>
          <span className={badgeClass}>{sourceLabel(group.source)}</span>
          <span className="shrink-0 text-xs text-zinc-500">
            {group.enabledCount === group.count
              ? t('{n} 个', { n: group.count })
              : t('{on} / {n} 个启用', { on: group.enabledCount, n: group.count })}
          </span>
        </button>
        {exclusive.length > 0 && (
          <span className="flex shrink-0 items-center -space-x-1" title={exclusive.map((c) => c.name).join('、')}>
            {exclusive.slice(0, 4).map((c) => (
              <Avatar key={c.id} name={c.name} url={c.avatarUrl} size={20} />
            ))}
          </span>
        )}
        <Button size="sm" variant="ghost" onClick={() => setPicking(!picking)}>
          {group.characters.length ? t('专用角色') : t('所有角色可用')}
        </Button>
        <Toggle label={t('启用')} checked={group.enabled} onChange={(enabled) => patchGroup({ enabled })} />
        {deletable &&
          (confirming ? (
            <Button
              size="sm"
              variant="danger"
              onBlur={() => setConfirming(false)}
              onClick={() => remove.mutate({ accountId: account.id, id: group.id, kind: 'sets' }, { onError })}
            >
              {t('确认删除')}
            </Button>
          ) : (
            <IconButton label={t('删除这一组')} onClick={() => setConfirming(true)}>
              <TrashIcon />
            </IconButton>
          ))}
      </div>
      {picking && (
        <div className="space-y-1.5 border-t border-zinc-100 px-3 py-2 dark:border-zinc-800">
          <CharacterChips value={group.characters} onChange={(ids) => patchGroup({ characters: ids })} />
          <span className="block text-xs text-zinc-500">
            {t('勾选后只有这些角色会用这一组；一个都不勾表示所有角色都能用')}
          </span>
        </div>
      )}
      {open && (
        <div className="grid max-h-80 grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-1.5 overflow-y-auto border-t border-zinc-100 p-2 dark:border-zinc-800">
          {group.entries.map((s) => (
            <StickerCell key={s.id} account={account} sticker={s} groupEnabled={group.enabled} />
          ))}
        </div>
      )}
    </section>
  )
}

/** 单个表情：点一下开关，悬停显示含义和删除 */
function StickerCell({
  account,
  sticker,
  groupEnabled,
}: {
  account: ChannelAccountDTO
  sticker: ChannelStickerDTO
  groupEnabled: boolean
}) {
  const update = useUpdateSticker()
  const remove = useDeleteSticker()
  const onError = (e: unknown) => toast.error(errorMessage(e))
  const meaning = sticker.meanings.join(' ') || t('（没有含义）')
  const active = sticker.enabled && groupEnabled
  const deletable = sticker.ref.kind !== 'face'
  return (
    <div
      className={cx(
        'group relative flex aspect-square flex-col items-center justify-center rounded-lg border border-zinc-200 p-1 dark:border-zinc-800',
        !active && 'opacity-40',
      )}
      title={`${meaning}${sticker.usageCount ? ` · ${t('用过 {n} 次', { n: sticker.usageCount })}` : ''}`}
    >
      <button
        type="button"
        aria-pressed={sticker.enabled}
        aria-label={sticker.enabled ? t('停用') : t('启用')}
        className="flex size-full flex-col items-center justify-center gap-0.5 overflow-hidden"
        onClick={() =>
          update.mutate({ accountId: account.id, id: sticker.id, patch: { enabled: !sticker.enabled } }, { onError })
        }
      >
        {sticker.previewUrl ? (
          <img src={sticker.previewUrl} alt={meaning} loading="lazy" className="max-h-10 max-w-full object-contain" />
        ) : (
          <span className="text-lg">{sticker.ref.kind === 'telegram' ? (sticker.ref.emoji ?? '🖼') : '🙂'}</span>
        )}
        <span className="w-full truncate text-center text-[11px] text-zinc-500">{sticker.meanings[0] ?? ''}</span>
      </button>
      {deletable && (
        <button
          type="button"
          aria-label={t('删除')}
          className="absolute top-0.5 right-0.5 hidden rounded bg-white/90 p-0.5 text-zinc-500 group-hover:block hover:text-red-600 dark:bg-zinc-900/90 [&_svg]:size-3.5"
          onClick={() => remove.mutate({ accountId: account.id, id: sticker.id }, { onError })}
        >
          <TrashIcon />
        </button>
      )}
    </div>
  )
}

function CharacterChips({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const characters = useCharacters().data ?? []
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])
  return (
    <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
      {characters.map((c) => {
        const on = value.includes(c.id)
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(c.id)}
            className={cx(
              'flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-[13px]',
              on
                ? 'border-violet-400 bg-violet-50 text-violet-800 dark:border-violet-700 dark:bg-violet-950/50 dark:text-violet-200'
                : 'border-zinc-200 text-zinc-600 hover:border-zinc-300 dark:border-zinc-700 dark:text-zinc-300',
            )}
          >
            <Avatar name={c.name} url={c.avatarUrl} size={20} />
            {c.name}
          </button>
        )
      })}
    </div>
  )
}
