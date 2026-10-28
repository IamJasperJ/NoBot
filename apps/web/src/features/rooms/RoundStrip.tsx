import type { RoomDTO } from '@nobot/shared'
import { useCharacter, useChatPages } from '../../api/queries'
import { useNextRound, useRoundReady, useSkipInitiative } from '../../api/rooms'
import { Button, cx } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'

const fail = (e: unknown) => toast.error(errorMessage(e))

/** 会话里 AI 角色的名字：群聊取成员，单人会话取那个角色 */
function useCharacterNames(chatId: string) {
  const page = useChatPages(chatId).data?.pages[0]
  const character = useCharacter(page?.chat.characterId ?? null).data
  const names: Record<string, string> = {}
  for (const m of page?.group?.members ?? []) names[m.characterId] = m.name
  if (character) names[character.id] = character.name
  return names
}

/**
 * 房间条下面的回合信息：
 * - 先攻模式：顺序条，标出轮到谁；轮到自己时可以跳过，主持可以跳过当前
 * - 主持收束 / 跑团：本轮完成进度，自己可以点「完成 / 跳过」，主持可以开下一轮
 */
export function RoundStrip({ room }: { room: RoomDTO }) {
  const names = useCharacterNames(room.chatId)
  const ready = useRoundReady()
  const next = useNextRound()
  const skip = useSkipInitiative()
  const active = room.members.filter((m) => m.state === 'active')
  const nameOf = (entry: { kind: string; id: string }) =>
    entry.kind === 'member'
      ? (active.find((m) => m.userId === entry.id)?.personaName ?? '?')
      : (names[entry.id] ?? t('AI 角色'))

  if (room.turnMode === 'initiative' && room.initiative.order.length) {
    const current = room.initiative.order[room.initiative.current]
    const mine = current?.kind === 'member' && current.id === room.myUserId
    return (
      <div className="pointer-events-auto flex max-w-full items-center gap-1.5 rounded-full border border-zinc-200 bg-white/90 py-1 pr-1 pl-2 text-xs shadow-sm backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/90">
        {/* 顺序条可以横向滚动，按钮固定在右边不被挤掉 */}
        <span className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
          <span className="shrink-0 text-zinc-500">{t('第 {n} 轮', { n: room.round.round })}</span>
          {room.initiative.order.map((entry, i) => (
            <span
              // 先攻表可以有重复的条目，用位置做 key
              key={`${i}-${entry.id}`}
              className={cx(
                'shrink-0 rounded-full px-2 py-0.5',
                i === room.initiative.current
                  ? 'bg-violet-600 font-semibold text-white'
                  : i < room.initiative.current
                    ? 'text-zinc-400 line-through'
                    : 'text-zinc-600 dark:text-zinc-300',
              )}
            >
              {nameOf(entry)}
            </span>
          ))}
        </span>
        {mine && (
          <Button size="sm" onClick={() => ready.mutateAsync({ id: room.id, state: 'passed' }).catch(fail)}>
            {t('跳过我')}
          </Button>
        )}
        {!mine && room.permissions.canManageInitiative && (
          <Button size="sm" onClick={() => skip.mutateAsync(room.id).catch(fail)}>
            {t('跳过当前')}
          </Button>
        )}
      </div>
    )
  }

  // 只有需要大家「都好了再推进」的模式才显示本轮进度
  if (room.turnMode !== 'host' && room.mode !== 'trpg') return null
  const players = active.filter((m) => m.role === 'player')
  if (!players.length) return null
  const states = room.round.members
  const settled = players.filter((m) => ['done', 'passed', 'away'].includes(states[m.userId] ?? 'pending')).length
  const me = states[room.myUserId] ?? 'pending'
  const amPlayer = players.some((m) => m.userId === room.myUserId)
  return (
    <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-zinc-200 bg-white/90 py-1 pr-1 pl-3 text-xs shadow-sm backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/90">
      <span className="text-zinc-500">
        {t('第 {n} 轮 · {done} / {total} 人好了', { n: room.round.round, done: settled, total: players.length })}
      </span>
      {players.length > 8 ? (
        // 人多时小圆点会挤成一条看不清的线，改成进度条；每个人的状态在成员页签里看
        <span
          className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={players.length}
          aria-valuenow={settled}
        >
          <span
            className="block h-full rounded-full bg-green-500"
            style={{ width: `${(settled / players.length) * 100}%` }}
          />
        </span>
      ) : (
        <span className="flex -space-x-1">
          {players.map((m) => {
            const state = states[m.userId] ?? 'pending'
            return (
              <span
                key={m.userId}
                title={`${m.personaName}：${
                  state === 'done'
                    ? t('完成')
                    : state === 'passed'
                      ? t('跳过')
                      : state === 'away'
                        ? t('离开')
                        : t('思考中')
                }`}
                className={cx(
                  'size-2.5 rounded-full ring-2 ring-white dark:ring-zinc-900',
                  state === 'done'
                    ? 'bg-green-500'
                    : state === 'passed'
                      ? 'bg-zinc-400'
                      : state === 'away'
                        ? 'bg-amber-400'
                        : 'bg-zinc-200 dark:bg-zinc-600',
                )}
              />
            )
          })}
        </span>
      )}
      {amPlayer &&
        (me === 'pending' || me === 'away' ? (
          <>
            <Button
              size="sm"
              variant="primary"
              onClick={() => ready.mutateAsync({ id: room.id, state: 'done' }).catch(fail)}
            >
              {t('本轮完成')}
            </Button>
            <Button size="sm" onClick={() => ready.mutateAsync({ id: room.id, state: 'passed' }).catch(fail)}>
              {t('跳过')}
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => ready.mutateAsync({ id: room.id, state: 'pending' }).catch(fail)}>
            {t('撤回完成')}
          </Button>
        ))}
      {room.permissions.canManageRounds && (
        <Button size="sm" onClick={() => next.mutateAsync(room.id).catch(fail)}>
          {t('下一轮')}
        </Button>
      )}
    </div>
  )
}
