import type { MessageDTO, PlayPresetData } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { resetChat } from '../../api/queries'
import { ChevronLeftIcon, ChevronRightIcon, RefreshIcon } from '../../components/icons'
import { Slot } from '../../extensions/Slot'
import type { VnBeatProps } from '../../extensions/types'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { runGeneration } from '../chat/generate'
import type { useVnPlayer } from './useVnPlayer'
import { Caret, SwipeButton } from './VnParts'

/**
 * ADV 版式的台词区：普通模式是底部对话框（名牌、备选切换、回退、进度），电影模式是只留字幕。
 */
export function VnDialogBox({
  chatId,
  messages,
  play,
  player,
  busy,
  cinema,
  speakerName,
  text,
  slotProps,
}: {
  chatId: string
  messages: MessageDTO[]
  play: PlayPresetData
  player: ReturnType<typeof useVnPlayer>
  busy: boolean
  cinema: boolean
  speakerName: string | null
  /** 这一句已经显示出来的文字（打字机进度） */
  text: string
  /** 对话框底部扩展插槽的参数 */
  slotProps: VnBeatProps
}) {
  const qc = useQueryClient()
  const { current, said } = player

  if (cinema)
    return (
      <div className="pointer-events-none relative z-10 mx-auto w-full max-w-3xl px-6 pb-[calc(var(--vn-letterbox)*0.5)] text-center">
        {speakerName && play.dialog.nameplate && (
          <div className="vn-subtitle-name mb-1 text-sm font-semibold">{speakerName}</div>
        )}
        <p className="vn-subtitle leading-relaxed whitespace-pre-wrap" style={{ fontSize: play.dialog.fontSize }}>
          {said ? text : player.streaming ? '……' : ''}
        </p>
      </div>
    )

  // 切换备选回复 / 备选开场白、重新生成：和聊天视图的规则一样——
  // 只有最后一条回复能重新生成（开场白没有父消息，只能在备选开场白之间切换）；重演旧回复时不显示
  const canRegenerate = !!current && current.parentId !== null && messages.at(-1)?.id === current.id
  const showSwipes =
    !!current && !player.pinned && !busy && !player.streaming && (current.swipeCount > 1 || canRegenerate)
  const regenerate = () => {
    if (!current) return
    void runGeneration(qc, chatId, { mode: 'regenerate', targetId: current.id }).catch((e) =>
      toast.error(errorMessage(e)),
    )
  }
  const swipe = async (direction: -1 | 1) => {
    if (!current) return
    if (direction === 1 && current.swipeIndex === current.swipeCount) {
      if (canRegenerate) regenerate()
      return
    }
    try {
      await api.swipe(chatId, { messageId: current.id, direction })
      await resetChat(qc, chatId)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <div className="pointer-events-none relative z-10 mx-auto w-full max-w-4xl px-3 pb-2 md:px-6">
      <div
        className="vn-box relative min-h-32 rounded-2xl px-5 pt-6 pb-8 md:px-7"
        style={{ ['--vn-box-alpha' as string]: `${play.dialog.boxOpacity}%`, fontSize: play.dialog.fontSize }}
      >
        {speakerName && play.dialog.nameplate && (
          <div className="vn-nameplate absolute -top-4 left-5 rounded-lg px-3 py-1 text-sm font-semibold">
            {speakerName}
          </div>
        )}
        {said ? (
          <p className="leading-relaxed whitespace-pre-wrap">{text}</p>
        ) : (
          <p className="text-sm opacity-60">
            {player.streaming ? '……' : current ? t('这条回复没有可演出的内容') : t('还没有角色回复，在下面说点什么吧')}
          </p>
        )}
        {showSwipes && current && (
          <div className="pointer-events-auto absolute bottom-1 left-3 flex items-center text-[11px] md:left-5">
            <SwipeButton
              label={current.parentId === null ? t('上一个开场白') : t('上一个回复')}
              disabled={current.swipeIndex <= 1}
              onClick={() => void swipe(-1)}
            >
              <ChevronLeftIcon />
            </SwipeButton>
            <span className="min-w-9 text-center tabular-nums opacity-60">
              {current.swipeIndex} / {current.swipeCount}
            </span>
            <SwipeButton
              label={
                current.swipeIndex < current.swipeCount
                  ? current.parentId === null
                    ? t('下一个开场白')
                    : t('下一个回复')
                  : t('生成新回复')
              }
              disabled={current.swipeIndex === current.swipeCount && !canRegenerate}
              onClick={() => void swipe(1)}
            >
              <ChevronRightIcon />
            </SwipeButton>
            {canRegenerate && (
              <SwipeButton label={t('重新生成（保留现有回复，再写一个）')} onClick={regenerate}>
                <RefreshIcon />
              </SwipeButton>
            )}
          </div>
        )}
        <div className="absolute right-4 bottom-2 flex items-center gap-2 text-[11px] opacity-60">
          <span className="pointer-events-auto flex items-center gap-1 empty:hidden">
            <Slot name="vn.dialog.footer" props={slotProps} />
          </span>
          {player.streaming && <span>{t('生成中…')}</span>}
          {player.canBack && (
            <button
              type="button"
              title={t('回退（看上一句，或上一条回复）')}
              aria-label={t('回退')}
              onClick={player.back}
              className="pointer-events-auto -my-1 flex size-6 items-center justify-center rounded-full hover:bg-white/15 [&_svg]:size-3.5"
            >
              <ChevronLeftIcon />
            </button>
          )}
          {player.shownCount > 0 && (
            <span className="tabular-nums">
              {player.index + 1} / {player.shownCount}
            </span>
          )}
          {player.complete && !player.ended && <Caret />}
        </div>
      </div>
    </div>
  )
}
