import type { SpriteDTO, StageState } from '@ai-parter/shared'
import { useQueries } from '@tanstack/react-query'
import { api } from '../../api/client'
import { keys } from '../../api/queries'
import { CheckIcon } from '../../components/icons'
import { Avatar, cx, Dialog } from '../../components/ui'
import { t } from '../../i18n'
import { useChatOps } from '../../stores/chatOps'
import { useSpriteLayout } from '../../stores/spriteLayout'
import type { ChatCast } from './MessageItem'

/**
 * 「切换立绘套装」：会话里每个角色一行（群聊时所有成员都列出），每套服装一张小缩略图（优先用 neutral 那张），点一下就换。
 * 只有一套立绘的成员也列出来，注明只有一套；还没有立绘的成员给出提示，避免群聊里看起来「只能选一个人」。
 * 「跟随剧情」= 用模型在舞台指令里写的服装。选择只保存在这台设备上（按会话记）
 */
export function OutfitPicker({ chatId, cast, stage }: { chatId: string; cast: ChatCast; stage: StageState | null }) {
  const open = useChatOps((s) => s.outfitPicker === chatId)
  const close = () => useChatOps.getState().setOutfitPicker(null)
  const ids = Object.keys(cast.speakers)
  const sprites = useQueries({
    queries: ids.map((id) => ({
      queryKey: keys.sprites(id),
      queryFn: () => api.listSprites(id),
      enabled: open,
      staleTime: 60_000,
    })),
  })
  const manual = useSpriteLayout((s) => s.outfits[chatId])
  const setOutfit = useSpriteLayout((s) => s.setOutfit)

  const rows = ids.map((id, i) => {
    const list = sprites[i]?.data ?? []
    const outfits = [...new Set(list.map((s) => s.outfit))].sort((a, b) =>
      a === '' ? -1 : b === '' ? 1 : a.localeCompare(b),
    )
    return { id, list, outfits, loading: !!sprites[i]?.isPending }
  })
  const anyChoice = rows.some((r) => r.outfits.length > 1)
  const loading = sprites.some((q) => q.isPending)

  return (
    <Dialog open={open} onClose={close} title={t('切换立绘套装')}>
      <div className="space-y-4">
        <p className="text-xs text-zinc-500">
          {t('选好的套装只保存在这台设备上，按会话记住。「跟随剧情」使用模型在舞台指令里写的服装。')}
        </p>
        {!loading && !anyChoice && (
          <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-500 dark:bg-zinc-900">
            {t('这个会话里的角色都只有一套立绘。可以在角色编辑页的「立绘」里新建服装。')}
          </p>
        )}
        {rows.map(({ id, list, outfits, loading: rowLoading }) => {
          const speaker = cast.speakers[id]
          const fromStage = stage?.cast.find((m) => m.characterId === id)?.outfit ?? ''
          const chosen = manual?.[id]
          return (
            <section key={id} className="space-y-2">
              <div className="flex items-center gap-2">
                <Avatar name={speaker?.name ?? ''} url={speaker?.avatarUrl ?? null} />
                <span className="text-sm font-medium">{speaker?.name}</span>
                {!rowLoading && outfits.length === 1 && (
                  <span className="text-xs text-zinc-400">{t('只有一套立绘')}</span>
                )}
              </div>
              {rowLoading ? (
                <p className="text-xs text-zinc-400">{t('加载中…')}</p>
              ) : outfits.length === 0 ? (
                <p className="text-xs text-zinc-400">{t('还没有立绘，可以在角色编辑页的「立绘」里上传或 AI 生成。')}</p>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2">
                  <OutfitTile
                    label={t('跟随剧情')}
                    hint={fromStage || t('默认服装')}
                    sprite={cover(list, fromStage)}
                    active={chosen === undefined}
                    onClick={() => setOutfit(chatId, id, null)}
                  />
                  {outfits.map((outfit) => (
                    <OutfitTile
                      key={outfit || '__default'}
                      label={outfit || t('默认服装')}
                      sprite={cover(list, outfit)}
                      active={chosen === outfit}
                      onClick={() => setOutfit(chatId, id, outfit)}
                    />
                  ))}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </Dialog>
  )
}

/** 这套服装的封面：neutral 优先，否则第一张 */
function cover(list: SpriteDTO[], outfit: string): SpriteDTO | undefined {
  const own = list.filter((s) => s.outfit === outfit)
  return own.find((s) => s.expression === 'neutral') ?? own[0]
}

function OutfitTile({
  label,
  hint,
  sprite,
  active,
  onClick,
}: {
  label: string
  hint?: string
  sprite: SpriteDTO | undefined
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        'group relative overflow-hidden rounded-lg border text-left transition-colors',
        active
          ? 'border-violet-500 ring-2 ring-violet-500/50'
          : 'border-zinc-200 hover:border-violet-300 dark:border-zinc-700',
      )}
    >
      <div className="sprite-cell aspect-[3/4] w-full">
        {sprite && (
          <img src={sprite.thumbUrl} alt="" loading="lazy" className="size-full object-contain object-bottom" />
        )}
      </div>
      <div className="border-t border-zinc-100 px-1.5 py-1 dark:border-zinc-800">
        <div className="truncate text-xs font-medium">{label}</div>
        {hint && <div className="truncate text-[10px] text-zinc-400">{hint}</div>}
      </div>
      {active && (
        <span className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-violet-600 text-white">
          <CheckIcon className="size-3" />
        </span>
      )}
    </button>
  )
}
