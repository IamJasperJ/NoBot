import { create } from 'zustand'
import { useAudioTracks, useAutoChatBgm, useChatBgm, useClearChatBgm, useSetChatBgm } from '../../../api/audio'
import { MusicIcon, PauseIcon, WandIcon } from '../../../components/icons'
import { cx, Dialog } from '../../../components/ui'
import { t } from '../../../i18n'
import { errorMessage, toast } from '../../../stores/toast'

/** 哪个会话的 BGM 选择框开着：菜单项在「+」菜单里，菜单收起时会卸载，所以对话框放在 chat.layer 里，用这个小 store 打开 */
const useBgmDialog = create<{ chatId: string | null }>(() => ({ chatId: null }))

/** 输入框「+」菜单里的「背景音乐…」 */
export function ChatBgmMenuEntry({ chatId, close }: { chatId: string; close: () => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        close()
        useBgmDialog.setState({ chatId })
      }}
      className="block w-full px-3 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
    >
      {t('背景音乐…')}
    </button>
  )
}

/**
 * 普通聊天的 BGM 选择框：自动（跟随舞台指令或让模型挑）、停止、或指定一首（指定后自动选择不再覆盖）。
 * 渲染在 chat.layer 里，只在打开的是当前会话时显示。
 */
export function ChatBgmDialog({ chatId }: { chatId: string }) {
  const open = useBgmDialog((s) => s.chatId === chatId)
  const close = () => useBgmDialog.setState({ chatId: null })
  return open ? <BgmPicker chatId={chatId} onClose={close} /> : null
}

function BgmPicker({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const tracks = useAudioTracks()
  const current = useChatBgm(chatId)
  const set = useSetChatBgm()
  const clear = useClearChatBgm()
  const auto = useAutoChatBgm()
  const bgm = (tracks.data ?? []).filter((track) => track.kind === 'bgm')
  const state = current.data
  const manual = state?.source === 'manual' && state.locked
  const busy = set.isPending || clear.isPending || auto.isPending
  const onError = (e: unknown) => toast.error(errorMessage(e))

  const row = (active: boolean) =>
    cx(
      'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
      active
        ? 'bg-violet-100 font-medium text-violet-800 dark:bg-violet-950 dark:text-violet-200'
        : 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
    )

  return (
    <Dialog open onClose={onClose} title={t('背景音乐')}>
      <div className="space-y-3">
        <p className="text-xs text-zinc-500">
          {t(
            '「自动」时跟随舞台指令里的 <bgm>，没有时按「音频」扩展的设置让模型挑选；指定一首后会一直播放它，直到切回自动。',
          )}
        </p>
        <div className="space-y-0.5">
          <button
            type="button"
            disabled={busy}
            className={row(!manual)}
            onClick={() => clear.mutate(chatId, { onError, onSuccess: onClose })}
          >
            <WandIcon />
            <span className="min-w-0 flex-1">{t('自动')}</span>
            {!manual && state?.track && (
              <span className="truncate text-xs font-normal opacity-70">
                {t('正在播放：{name}', { name: state.track.name })}
              </span>
            )}
          </button>
          <button
            type="button"
            disabled={busy}
            className={row(!!manual && state?.trackId === null)}
            onClick={() => set.mutate({ chatId, trackId: null, locked: true }, { onError, onSuccess: onClose })}
          >
            <PauseIcon />
            <span>{t('不播放')}</span>
          </button>
        </div>
        <div className="border-t border-zinc-100 pt-2 dark:border-zinc-800">
          {tracks.isLoading ? (
            <p className="py-4 text-center text-sm text-zinc-500">{t('加载中…')}</p>
          ) : bgm.length === 0 ? (
            <p className="py-4 text-center text-sm text-zinc-500">
              {t('音频库里还没有背景音乐，可以在扩展页「音频」的「音频库」里上传。')}
            </p>
          ) : (
            <div className="max-h-72 space-y-0.5 overflow-y-auto">
              {bgm.map((track) => (
                <button
                  key={track.id}
                  type="button"
                  disabled={busy}
                  className={row(!!manual && state?.trackId === track.id)}
                  onClick={() =>
                    set.mutate({ chatId, trackId: track.id, locked: true }, { onError, onSuccess: onClose })
                  }
                >
                  <MusicIcon />
                  <span className="min-w-0 flex-1 truncate">{track.name}</span>
                  {track.description && (
                    <span className="hidden max-w-[45%] truncate text-xs font-normal opacity-60 sm:block">
                      {track.description}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          disabled={busy || bgm.length === 0}
          onClick={() =>
            auto.mutate(
              { chatId },
              {
                onError,
                onSuccess: () => {
                  toast.info(t('已让模型重新挑选'))
                  onClose()
                },
              },
            )
          }
          className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] text-violet-600 hover:bg-violet-50 disabled:opacity-50 dark:text-violet-400 dark:hover:bg-violet-950/40 [&_svg]:size-4"
        >
          <WandIcon />
          {auto.isPending ? t('正在挑选…') : t('让模型现在挑一首')}
        </button>
      </div>
    </Dialog>
  )
}
