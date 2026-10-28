import type { RoomDTO } from '@nobot/shared'
import { useEffect, useRef, useState } from 'react'
import { useAbortRoomTurn, useRequestRoomTurn, useTriggerRoomTurn } from '../../api/rooms'
import { StopIcon, UsersIcon } from '../../components/icons'
import { Avatar, Button, cx } from '../../components/ui'
import { t } from '../../i18n'
import { useRoomLive } from '../../stores/room'
import { errorMessage, toast } from '../../stores/toast'
import { RoundStrip } from './RoundStrip'
import { namesText, turnModeLabel, useRoomDialogs } from './shared'

const fail = (e: unknown) => toast.error(errorMessage(e))

/** 每秒刷新一次，用于倒计时和「正在输入」过期 */
function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/**
 * 联机房间的悬浮条（聊天区右上角）：成员头像、谁在输入、AI 回合状态，
 * 以及按权限出现的「让 AI 回应 / 请主持回应 / 停止」。点头像打开房间管理。
 */
export function RoomBar({ room }: { room: RoomDTO }) {
  const turn = useRoomLive((s) => s.turns[room.id])
  const typingMap = useRoomLive((s) => s.typing[room.id])
  const now = useNow(!!typingMap || !!turn?.waitingUntil || !!turn?.cooldownUntil)
  const trigger = useTriggerRoomTurn()
  const abort = useAbortRoomTurn()
  const request = useRequestRoomTurn()
  const openManage = useRoomDialogs((s) => s.openManage)
  // 房间条浮在聊天区上方：把它的高度写成父元素上的 CSS 变量 --room-bar-h，
  // VN 的顶部操作栏 / 状态栏和手机上的消息列表据此让开，不被挡住
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    const host = el?.parentElement
    if (!el || !host) return
    const update = () =>
      host.style.setProperty('--room-bar-h', `${Math.ceil(el.getBoundingClientRect().height) + 12}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => {
      observer.disconnect()
      host.style.removeProperty('--room-bar-h')
    }
  }, [])

  const active = room.members.filter((m) => m.state === 'active')
  const typing = Object.entries(typingMap ?? {})
    .filter(([userId, until]) => until > now && userId !== room.myUserId)
    .map(([userId]) => active.find((m) => m.userId === userId)?.personaName)
    .filter((name): name is string => !!name)
  const waiting = turn?.waitingUntil && turn.waitingUntil > now ? Math.ceil((turn.waitingUntil - now) / 1000) : 0
  const pending = turn?.pendingCount ?? 0
  const paused = room.status !== 'active'
  const mustAccept =
    [...room.members, ...room.spectators].find((m) => m.userId === room.myUserId)?.acceptedRulesVersion !==
    room.rulesVersion

  // 状态文字按优先级取一条，避免挤成一排
  const status = paused
    ? t('房间已暂停')
    : turn?.running
      ? t('AI 正在回复…')
      : typing.length
        ? t('{names} 正在输入…', { names: namesText(typing) })
        : waiting
          ? t('{seconds} 秒后 AI 回应', { seconds: waiting })
          : pending && room.turnMode === 'host'
            ? t('{count} 条发言等待回应', { count: pending })
            : turnModeLabel()[room.turnMode]

  return (
    <div
      ref={ref}
      className="room-bar pointer-events-none absolute top-3 right-3 left-14 z-20 flex flex-col items-end gap-1.5 md:left-3"
    >
      <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-zinc-200 bg-white/90 py-1 pr-1.5 pl-1 shadow-sm backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/90">
        <button
          type="button"
          onClick={() => openManage(room.id)}
          title={t('房间成员与设置')}
          className="flex min-w-0 items-center gap-2 rounded-full py-0.5 pr-1 pl-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span className="flex shrink-0 -space-x-2">
            {active.slice(0, 4).map((m) => (
              <span key={m.userId} className="relative rounded-full ring-2 ring-white dark:ring-zinc-900">
                <Avatar name={m.personaName} size={26} />
                {m.inRoom && (
                  <span className="absolute right-0 bottom-0 size-2 rounded-full bg-green-500 ring-2 ring-white dark:ring-zinc-900" />
                )}
              </span>
            ))}
            {active.length > 4 && (
              <span className="flex size-[26px] items-center justify-center rounded-full bg-zinc-200 text-[11px] font-semibold text-zinc-600 ring-2 ring-white dark:bg-zinc-700 dark:text-zinc-200 dark:ring-zinc-900">
                +{active.length - 4}
              </span>
            )}
          </span>
          <span className="flex min-w-0 flex-col items-start leading-tight">
            <span className="max-w-24 truncate text-xs font-semibold sm:max-w-40">{room.name}</span>
            <span
              aria-live="polite"
              className={cx(
                'max-w-28 truncate text-[11px] sm:max-w-48',
                turn?.running || typing.length ? 'text-violet-600 dark:text-violet-400' : 'text-zinc-500',
              )}
            >
              {status}
            </span>
          </span>
        </button>
        {mustAccept ? (
          <Button size="sm" variant="primary" onClick={() => openManage(room.id, 'me')}>
            {t('确认新规则')}
          </Button>
        ) : turn?.running ? (
          room.permissions.canAbort && (
            <Button size="sm" onClick={() => abort.mutateAsync(room.id).catch(fail)}>
              <StopIcon />
              {t('停止')}
            </Button>
          )
        ) : room.permissions.canTrigger ? (
          <Button
            size="sm"
            variant={pending && room.turnMode === 'host' ? 'primary' : 'secondary'}
            disabled={paused || trigger.isPending}
            onClick={() => trigger.mutateAsync(room.id).catch(fail)}
          >
            {t('让 AI 回应')}
          </Button>
        ) : (
          room.turnMode === 'host' &&
          pending > 0 &&
          !room.permissions.isSpectator && (
            <Button
              size="sm"
              disabled={paused || request.isPending}
              onClick={() =>
                request
                  .mutateAsync(room.id)
                  .then(() => toast.info(t('已提醒主持')))
                  .catch(fail)
              }
            >
              {t('请主持回应')}
            </Button>
          )
        )}
      </div>
      <RoundStrip room={room} />
      {turn?.error && <span className="sr-only">{turn.error}</span>}
    </div>
  )
}
