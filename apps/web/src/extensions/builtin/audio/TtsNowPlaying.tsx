import { StopIcon, VolumeIcon } from '../../../components/icons'
import { cx } from '../../../components/ui'
import { t } from '../../../i18n'
import { ttsPlayer, useTtsPlayback } from './tts-player'

/**
 * 正在朗读时画面顶部居中的小胶囊：随时一键停止。
 * 聊天视图和 VN 各挂一份，只显示属于当前会话的朗读（离开会话时朗读本来就会停）。
 */
export function TtsNowPlaying({ chatId, vn = false }: { chatId: string; vn?: boolean }) {
  const playing = useTtsPlayback((s) => s.playing && (s.chatId === null || s.chatId === chatId))
  if (!playing) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center">
      <button
        type="button"
        onClick={() => ttsPlayer.stop()}
        aria-label={t('停止朗读')}
        className={cx(
          'vn-tools-in pointer-events-auto flex h-8 items-center gap-2 rounded-full pr-3 pl-2.5 text-[12px] font-medium shadow-sm transition-colors',
          vn
            ? 'vn-chip'
            : 'border border-zinc-200 bg-white/90 text-zinc-700 backdrop-blur hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-200 dark:hover:bg-zinc-800',
        )}
      >
        <VolumeIcon className="size-3.5 animate-pulse text-violet-500" />
        <span>{t('正在朗读')}</span>
        <span aria-hidden="true" className="h-3 w-px bg-current opacity-25" />
        <StopIcon className="size-3.5" />
        <span>{t('停止')}</span>
      </button>
    </div>
  )
}
