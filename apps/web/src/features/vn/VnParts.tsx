import type { ChoiceOption } from '@nobot/shared'
import type { ReactNode } from 'react'
import { cx } from '../../components/ui'
import { t } from '../../i18n'
import { useSpriteLayout } from '../../stores/spriteLayout'
import { checkSkillLabel } from '../trpg/labels'
import type { useVnPlayer } from './useVnPlayer'

/** 调整立绘时代替输入框的操作条：说明、整体大小、全部恢复、完成 */
export function AdjustBar({ chatId, onDone }: { chatId: string; onDone: () => void }) {
  const all = useSpriteLayout((s) => s.vn[chatId]?.all ?? 1)
  const setAll = useSpriteLayout((s) => s.setAll)
  const resetChat = useSpriteLayout((s) => s.resetChat)
  return (
    <div className="relative z-20 mx-auto mb-3 w-full max-w-4xl px-3 md:px-6">
      <div className="vn-box flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl px-4 py-3 text-sm">
        <span className="min-w-0 flex-1 text-xs opacity-75">
          {t('拖动立绘调整位置，滚轮或双指捏合缩放。只保存在这台设备上，按会话记住。')}
        </span>
        <label className="flex items-center gap-2 text-xs">
          {t('整体大小')}
          <input
            type="range"
            min={30}
            max={300}
            step={5}
            value={Math.round(all * 100)}
            onChange={(e) => setAll(chatId, Number(e.target.value) / 100)}
            className="w-28 accent-violet-400"
          />
          <span className="w-10 tabular-nums">{Math.round(all * 100)}%</span>
        </label>
        <button
          type="button"
          className="vn-chip rounded-full px-3 py-1 text-xs"
          onClick={() => {
            if (confirm(t('恢复这个会话里所有立绘的默认位置和大小？'))) resetChat(chatId)
          }}
        >
          {t('全部恢复')}
        </button>
        <button type="button" className="vn-chip vn-chip-active rounded-full px-4 py-1 text-xs" onClick={onDone}>
          {t('完成')}
        </button>
      </div>
    </div>
  )
}

/** 对话框里切换备选的小按钮 */
export function SwipeButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-full opacity-60 hover:bg-white/10 hover:opacity-100 disabled:opacity-25 disabled:hover:bg-transparent [&_svg]:size-3.5"
    >
      {children}
    </button>
  )
}

/** 「这一句显示完了，点一下继续」的小三角 */
export function Caret() {
  return <span className="vn-caret inline-block">▼</span>
}

/** 顶部操作栏的圆形按钮 */
export function VnButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        'vn-chip relative flex size-9 items-center justify-center rounded-full transition-colors [&_svg]:size-4',
        active && 'vn-chip-active',
      )}
    >
      {children}
    </button>
  )
}

/** 按钮角上的小圆点：有新图片（生成中时闪烁）或其他状态提示 */
export function Dot({ pulse }: { pulse: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cx('absolute top-1 right-1 size-2 rounded-full', pulse ? 'animate-pulse bg-violet-400' : 'bg-white')}
    />
  )
}

/** 选项：画面中央偏下，像 Galgame 的选择肢；少且短时横排 */
export function VnChoices({
  options,
  row,
  disabled,
  showDc,
  onPick,
}: {
  options: ChoiceOption[]
  row: boolean
  disabled: boolean
  showDc: boolean
  onPick: (option: ChoiceOption) => void
}) {
  return (
    <div
      className={cx(
        'relative z-10 mx-auto mb-3 flex w-full gap-2 px-4',
        row ? 'max-w-3xl flex-wrap justify-center' : 'max-w-xl flex-col',
      )}
    >
      {options.map((option, i) => (
        <button
          // 选项在消息定稿后不变，下标做 key 是安全的
          key={i}
          type="button"
          disabled={disabled}
          onClick={() => onPick(option)}
          className={cx(
            'vn-choice flex min-h-11 items-center gap-3 rounded-xl px-4 py-2 text-left text-sm disabled:opacity-50',
            row ? 'min-w-32 justify-center' : 'w-full',
          )}
        >
          <span className="min-w-0 flex-1">{option.text}</span>
          {option.check && (
            <span className="shrink-0 rounded-md bg-amber-400/20 px-1.5 py-0.5 text-[11px] font-medium text-amber-200">
              {checkSkillLabel(option.check.skill)}
              {showDc && ` DC${option.check.dc}`}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

/** CG 拍：全屏铺满显示生成的插图（和背景一样按屏幕裁切，不留黑边）；还在画时显示占位 */
export function VnCg({ cg }: { cg: NonNullable<ReturnType<typeof useVnPlayer>['cg']> }) {
  return (
    <div className="vn-cg pointer-events-none absolute inset-0 z-[6] flex items-center justify-center bg-black">
      {cg.url ? (
        <img key={cg.url} src={cg.url} alt={cg.prompt} className="vn-cg-image size-full object-cover" />
      ) : (
        <div className="flex flex-col items-center gap-3 text-sm text-white/70">
          <span className="size-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          {t('正在绘制 CG…')}
        </div>
      )}
    </div>
  )
}
