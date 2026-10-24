import { useEffect, useState } from 'react'
import { useChoiceVotes, useCloseChoice } from '../../api/rooms'
import { Button, cx } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { useRoomInfo } from './shared'

/**
 * 房间里的选项能不能点：主持决定模式下只有房主 / 主持能选；投票和各自选模式人人可选（点击即投票）。
 * 不在房间里时不限制。
 */
export function useChoiceGate(chatId: string) {
  const room = useRoomInfo(chatId)
  if (!room) return { locked: false, hint: null }
  if (!room.permissions.canPickChoice) {
    return {
      locked: true,
      hint: room.choiceMode === 'gm' ? t('由房主或主持选择') : t('现在不能选择'),
    }
  }
  return { locked: false, hint: null }
}

/** 投票 / 各自选模式下，选项下方的进度：每项票数、截止倒计时、主持提前结束 */
export function RoomChoiceStatus({
  chatId,
  messageId,
  count,
  className,
}: {
  chatId: string
  messageId: string
  count: number
  className?: string
}) {
  const room = useRoomInfo(chatId)
  const active = !!room && room.choiceMode !== 'gm'
  const votes = useChoiceVotes(active ? room.id : '', active ? messageId : '')
  const close = useCloseChoice()
  const [now, setNow] = useState(Date.now)
  const state = votes.data
  useEffect(() => {
    if (!state || state.closed) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [state])
  if (!room || !active || !state) return null
  const voters = room.members.filter((m) => m.state === 'active' && m.role !== 'owner').length || 1
  const mine = state.votes[room.myUserId]
  const left = Math.max(0, Math.ceil((state.deadline - now) / 1000))
  const counts = Array.from({ length: count }, (_, i) => state.counts[i] ?? 0)
  return (
    <div
      className={cx(
        'mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-800/70 dark:text-zinc-300',
        className,
      )}
    >
      {state.closed ? (
        <span className="font-medium">
          {state.winner === null ? t('投票已结束') : t('投票结束，选了第 {n} 项', { n: state.winner + 1 })}
        </span>
      ) : room.choiceMode === 'each' ? (
        <span>{t('各自选择：{done} / {total} 人已选', { done: state.picks.length, total: voters })}</span>
      ) : (
        <>
          <span className="flex flex-wrap gap-2 tabular-nums">
            {counts.map((n, i) => (
              <span
                // 选项数量固定，下标做 key 安全
                key={i}
                className={cx(mine === i && 'font-semibold text-violet-700 dark:text-violet-300')}
              >
                {t('{index}：{count} 票', { index: i + 1, count: n })}
              </span>
            ))}
          </span>
          <span className="text-zinc-400">{t('{seconds} 秒后截止', { seconds: left })}</span>
        </>
      )}
      {mine !== undefined && !state.closed && room.choiceMode === 'vote' && (
        <span>{t('你投了第 {n} 项', { n: mine + 1 })}</span>
      )}
      {!state.closed && room.permissions.canCloseChoices && (
        <Button
          size="sm"
          className="ml-auto"
          onClick={() =>
            void close.mutateAsync({ id: room.id, messageId }).catch((e: unknown) => toast.error(errorMessage(e)))
          }
        >
          {t('现在结束')}
        </Button>
      )}
    </div>
  )
}
