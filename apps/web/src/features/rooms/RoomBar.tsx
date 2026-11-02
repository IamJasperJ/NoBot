import type { RoomDTO } from '@nobot/shared'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useAbortRoomTurn, useRequestRoomTurn, useTriggerRoomTurn } from '../../api/rooms'
import { StopIcon } from '../../components/icons'
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
 * inline：放进 VN 顶栏那一行，换成 VN 的深色胶囊样式，不再浮在上方把顶栏挤下去。
 */
export function RoomBar({ room, inline = false }: { room: RoomDTO; inline?: boolean }) {
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
    if (inline) return
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
  }, [inline])

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

  // VN 里背景是画面，白色按钮太跳：换成和 VN 胶囊一致的半透明按钮
  const act = (label: ReactNode, onClick: () => void, opts: { primary?: boolean; disabled?: boolean } = {}) =>
    inline ? (
      <button
        type="button"
        disabled={opts.disabled}
        onClick={onClick}
        className={cx(
          'flex h-7 shrink-0 items-center gap-1 rounded-full px-3 text-xs font-medium transition-colors disabled:opacity-50 [&_svg]:size-3.5',
          opts.primary ? 'bg-violet-600/90 hover:bg-violet-600' : 'bg-white/15 hover:bg-white/25',
        )}
      >
        {label}
      </button>
    ) : (
      <Button size="sm" variant={opts.primary ? 'primary' : 'secondary'} disabled={opts.disabled} onClick={onClick}>
        {label}
      </Button>
    )
  const action = mustAccept
    ? act(t('确认新规则'), () => openManage(room.id, 'me'), { primary: true })
    : turn?.running
      ? room.permissions.canAbort &&
        act(
          <>
            <StopIcon />
            {t('停止')}
          </>,
          () => void abort.mutateAsync(room.id).catch(fail),
        )
      : room.permissions.canTrigger
        ? act(t('让 AI 回应'), () => void trigger.mutateAsync(room.id).catch(fail), {
            primary: !!pending && room.turnMode === 'host',
            disabled: paused || trigger.isPending,
          })
        : room.turnMode === 'host' &&
          pending > 0 &&
          !room.permissions.isSpectator &&
          act(
            t('请主持回应'),
            () =>
              void request
                .mutateAsync(room.id)
                .then(() => toast.info(t('已提醒主持')))
                .catch(fail),
            { disabled: paused || request.isPending },
          )

  return (
    <div
      ref={ref}
      className={cx(
        'room-bar flex flex-col items-end gap-1.5',
        inline
          ? 'pointer-events-auto min-w-0 shrink'
          : 'pointer-events-none absolute top-3 right-3 left-14 z-20 md:left-3',
      )}
    >
      <div
        className={cx(
          'pointer-events-auto flex max-w-full items-center gap-2 rounded-full',
          inline
            ? 'vn-chip h-9 py-0.5 pr-1 pl-0.5'
            : 'border border-zinc-200 bg-white/90 py-1 pr-1.5 pl-1 shadow-sm backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/90',
        )}
      >
        <button
          type="button"
          onClick={() => openManage(room.id)}
          title={t('房间成员与设置')}
          className={cx(
            'flex min-w-0 items-center gap-2 rounded-full py-0.5 pr-1 pl-0.5',
            inline ? 'hover:bg-white/10' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800',
          )}
        >
          <span className="flex shrink-0 -space-x-2">
            {active.slice(0, 4).map((m) => (
              <span
                key={m.userId}
                className={cx(
                  'relative rounded-full ring-2',
                  inline ? 'ring-black/40' : 'ring-white dark:ring-zinc-900',
                )}
              >
                <Avatar name={m.personaName} size={inline ? 24 : 26} />
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
          {/* VN 顶栏在手机上一行放不下房间名，只留头像和按钮；名字和状态在房间管理里看 */}
          <span
            className={cx(
              'min-w-0 flex-col items-start leading-tight',
              inline ? 'hidden overflow-hidden sm:flex' : 'flex',
            )}
          >
            <span className="max-w-24 truncate text-xs font-semibold sm:max-w-40">{room.name}</span>
            <span
              aria-live="polite"
              className={cx(
                'max-w-28 truncate text-[11px] sm:max-w-48',
                turn?.running || typing.length
                  ? inline
                    ? 'text-violet-300'
                    : 'text-violet-600 dark:text-violet-400'
                  : inline
                    ? 'text-zinc-300'
                    : 'text-zinc-500',
              )}
            >
              {status}
            </span>
          </span>
        </button>
        {action}
      </div>
      <RoundStrip room={room} />
      {turn?.error && <span className="sr-only">{turn.error}</span>}
    </div>
  )
}
