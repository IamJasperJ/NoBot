import { useEffect, useRef, useState } from 'react'
import { VolumeIcon, VolumeOffIcon } from '../../../components/icons'
import { cx } from '../../../components/ui'
import { t } from '../../../i18n'
import { useAudioPrefs } from '../../../stores/audioPrefs'

/**
 * VN 工具栏的音量按钮（vn.toolbar 插槽）：点一下展开小面板，里面是静音开关和总音量滑块。
 * 只影响这个浏览器；各声道音量在玩法预设的「音频」里调。
 */
export function VolumeControl() {
  const muted = useAudioPrefs((s) => s.muted)
  const master = useAudioPrefs((s) => s.master)
  const setMuted = useAudioPrefs((s) => s.setMuted)
  const setMaster = useAudioPrefs((s) => s.setMaster)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => {
      if (e.target instanceof Node && !root.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  const silent = muted || master === 0
  const label = silent ? t('已静音') : t('音量 {value}%', { value: master })
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cx(
          'vn-chip relative flex size-9 items-center justify-center rounded-full transition-colors [&_svg]:size-4',
          open && 'vn-chip-active',
        )}
      >
        {silent ? <VolumeOffIcon /> : <VolumeIcon />}
      </button>
      {open && (
        <div className="vn-chip absolute top-full right-0 z-30 mt-2 flex w-52 items-center gap-2 rounded-2xl px-2.5 py-2">
          <button
            type="button"
            onClick={() => setMuted(!muted)}
            aria-pressed={muted}
            title={muted ? t('取消静音') : t('静音')}
            aria-label={muted ? t('取消静音') : t('静音')}
            className="flex size-7 shrink-0 items-center justify-center rounded-full hover:bg-white/15 [&_svg]:size-4"
          >
            {silent ? <VolumeOffIcon /> : <VolumeIcon />}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={muted ? 0 : master}
            aria-label={t('总音量')}
            onChange={(e) => {
              setMaster(Number(e.target.value))
              if (muted) setMuted(false)
            }}
            className="min-w-0 flex-1 accent-violet-500"
          />
          <span className="w-8 shrink-0 text-right text-[11px] tabular-nums">{muted ? 0 : master}</span>
        </div>
      )}
    </div>
  )
}
