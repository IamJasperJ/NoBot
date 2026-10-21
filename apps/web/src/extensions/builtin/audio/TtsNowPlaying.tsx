import { useEffect, useRef, useState } from 'react'
import { StopIcon, VolumeIcon, VolumeOffIcon, XIcon } from '../../../components/icons'
import { cx } from '../../../components/ui'
import { t } from '../../../i18n'
import { useVnVoiceStore } from '../../../stores/vnVoice'
import { ttsPlayer, useTtsPlayback } from './tts-player'

/** 失败提示停留多久后自动消失 */
const ERROR_MS = 8000

/**
 * 画面顶部居中的朗读状态胶囊，聊天视图和 VN 各挂一份，按优先级显示一种：
 * 1. 被浏览器拦了自动播放：提示点一下（任意点击都会让引擎在手势里重试，点这颗胶囊也一样）
 * 2. 最近一次朗读失败：显示原因，8 秒后或点 × 消失
 * 3. 正在朗读（属于当前会话）：一键停止
 */
export function TtsNowPlaying({ chatId, vn = false }: { chatId: string; vn?: boolean }) {
  const playing = useTtsPlayback((s) => s.playing && (s.chatId === null || s.chatId === chatId))
  const blocked = useVnVoiceStore((s) => s.voiceBlocked)
  const error = useVnVoiceStore((s) => s.lastVoiceError)
  const [dismissedAt, setDismissedAt] = useState(0)
  // 点「开启声音」胶囊时，同一次触摸会先解锁并开播、胶囊随即变成「停止」按钮，
  // 紧接着到达的 click 会落在新按钮上把刚开始的朗读停掉。记下解锁时刻，短时间内忽略停止点击。
  const unblockedAt = useRef(0)
  const wasBlocked = useRef(blocked)
  useEffect(() => {
    if (wasBlocked.current && !blocked) unblockedAt.current = Date.now()
    wasBlocked.current = blocked
  }, [blocked])
  const [now, setNow] = useState(() => Date.now())
  // 失败提示到点自动隐藏
  useEffect(() => {
    if (!error) return
    setNow(Date.now())
    const left = error.at + ERROR_MS - Date.now()
    if (left <= 0) return
    const timer = setTimeout(() => setNow(Date.now()), left)
    return () => clearTimeout(timer)
  }, [error])
  const showError = !!error && error.at > dismissedAt && now - error.at < ERROR_MS

  const pill = cx(
    'vn-tools-in pointer-events-auto flex h-8 max-w-[min(32rem,calc(100vw-32px))] items-center gap-2 rounded-full pr-3 pl-2.5 text-[12px] font-medium shadow-sm transition-colors',
    vn
      ? 'vn-chip'
      : 'border border-zinc-200 bg-white/90 text-zinc-700 backdrop-blur hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/90 dark:text-zinc-200 dark:hover:bg-zinc-800',
  )

  let content: React.ReactNode = null
  if (blocked)
    content = (
      // 点击本身就是用户手势，引擎会在这次点击里重试这一句，这里不需要额外调用
      <button type="button" className={cx(pill, 'animate-pulse')} aria-live="polite">
        <VolumeOffIcon className="size-3.5 shrink-0 text-amber-500" />
        <span className="truncate">{t('浏览器拦住了自动播放，点一下开启声音')}</span>
      </button>
    )
  else if (showError)
    content = (
      <div className={pill} role="status">
        <VolumeOffIcon className="size-3.5 shrink-0 text-red-500" />
        <span className="truncate" title={error.message}>
          {t('朗读失败：{message}', { message: error.message })}
        </span>
        <button
          type="button"
          aria-label={t('关闭')}
          className="-mr-1 shrink-0 rounded-full p-0.5 opacity-60 hover:opacity-100"
          onClick={() => setDismissedAt(error.at)}
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
    )
  else if (playing)
    content = (
      <button
        type="button"
        onClick={() => {
          if (Date.now() - unblockedAt.current > 800) ttsPlayer.stop()
        }}
        aria-label={t('停止朗读')}
        className={pill}
      >
        <VolumeIcon className="size-3.5 animate-pulse text-violet-500" />
        <span>{t('正在朗读')}</span>
        <span aria-hidden="true" className="h-3 w-px bg-current opacity-25" />
        <StopIcon className="size-3.5" />
        <span>{t('停止')}</span>
      </button>
    )

  if (!content) return null
  return <div className="pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-4">{content}</div>
}
