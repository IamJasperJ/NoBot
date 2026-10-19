import type { CombatState } from '@ai-parter/shared'
import { Avatar, cx } from '../../components/ui'
import { t } from '../../i18n'

/**
 * 战斗时 VN 顶部的先攻条：按先攻顺序排一排头像，当前行动者高亮放大，头像下面是 HP 条。
 * HP 从会话变量读（玩家用 player.hp / player.maxHp，其他人用 <名字>.hp / <名字>.maxHp），没有就不画条。
 */
export function InitiativeBar({
  combat,
  vars,
  avatarOf,
  playerName,
}: {
  combat: CombatState
  vars: Record<string, unknown>
  /** 按角色 id 或名字找头像，找不到返回 null（显示名字首字） */
  avatarOf: (who: { name: string; characterId?: string | null }) => string | null
  /** 当前人设名：先攻表里它对应变量前缀 player */
  playerName: string
}) {
  const hpOf = (name: string) => {
    const prefix = name === playerName || name.toLowerCase() === 'player' ? 'player' : name
    const hp = Number(vars[`${prefix}.hp`])
    const max = Number(vars[`${prefix}.maxHp`])
    return Number.isFinite(hp) && Number.isFinite(max) && max > 0 ? { hp, max } : null
  }
  return (
    <div className="pointer-events-auto flex max-w-full items-end gap-2 overflow-x-auto rounded-2xl bg-black/45 px-3 pt-2 pb-1.5 text-white backdrop-blur-md">
      <div className="mr-1 flex shrink-0 flex-col items-center self-center leading-tight">
        <span className="text-[10px] uppercase tracking-wider text-white/60">{t('回合')}</span>
        <span className="text-lg font-bold tabular-nums">{combat.round}</span>
      </div>
      {combat.order.map((c, i) => {
        const current = i === combat.turn
        const hp = hpOf(c.name)
        const down = hp !== null && hp.hp <= 0
        return (
          <div
            key={c.key}
            className={cx(
              'flex w-12 shrink-0 flex-col items-center gap-1 transition-all duration-300',
              current ? 'scale-110' : 'opacity-70',
              down && 'grayscale',
            )}
            title={t('{name}，先攻 {value}', { name: c.name, value: c.initiative })}
          >
            <div className={cx('rounded-full', current && 'ring-2 ring-amber-400 ring-offset-2 ring-offset-black/40')}>
              <Avatar name={c.name} url={avatarOf(c)} size={36} />
            </div>
            <span className="w-full truncate text-center text-[10px] leading-none">{c.name}</span>
            {hp ? (
              <span className="h-1 w-full overflow-hidden rounded-full bg-white/20" aria-hidden="true">
                <span
                  className={cx('block h-full rounded-full', hp.hp / hp.max > 0.3 ? 'bg-emerald-400' : 'bg-red-500')}
                  style={{ width: `${Math.max(0, Math.min(100, (hp.hp / hp.max) * 100))}%` }}
                />
              </span>
            ) : (
              <span className="h-1" />
            )}
          </div>
        )
      })}
    </div>
  )
}
