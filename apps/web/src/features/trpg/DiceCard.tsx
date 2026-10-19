import type { CheckResult, DiceResult } from '@ai-parter/shared'
import type { CSSProperties } from 'react'
import { cx } from '../../components/ui'
import { t } from '../../i18n'
import { checkLabel, signed } from './labels'

/**
 * 掷骰 / 检定的展示卡片。普通聊天里用 compact（一行徽章），VN 里用完整卡片。
 * 动画只靠 CSS：骰子先翻滚 --dice-ms，再显示点数；总值和结论在骰子停下后淡入。
 * animate=false（历史消息、关闭骰子动画）时直接显示结果。
 */

const outcomeText = (outcome: CheckResult['outcome']) => {
  switch (outcome) {
    case 'crit_success':
      return t('大成功')
    case 'success':
      return t('成功')
    case 'fail':
      return t('失败')
    case 'crit_fail':
      return t('大失败')
    default:
      return ''
  }
}

const outcomeTone = (outcome: CheckResult['outcome'] | 'crit' | 'fumble' | undefined) =>
  outcome === 'crit_success' || outcome === 'crit'
    ? 'text-amber-600 dark:text-amber-400'
    : outcome === 'success'
      ? 'text-emerald-600 dark:text-emerald-400'
      : outcome === 'crit_fail' || outcome === 'fumble'
        ? 'text-red-600 dark:text-red-400'
        : outcome === 'fail'
          ? 'text-zinc-500'
          : ''

/** 一颗骰子：d20 画成六边形，其余画成圆角方块；舍弃的骰子变淡并划线 */
function Die({
  sides,
  value,
  kept,
  natural,
}: {
  sides: number
  value: number
  kept: boolean
  natural?: 'crit' | 'fumble'
}) {
  return (
    <span
      className={cx(
        'dice-die relative inline-flex size-8 shrink-0 items-center justify-center text-[13px] font-semibold tabular-nums',
        sides === 20 ? 'dice-d20' : 'rounded-md',
        kept
          ? natural === 'crit'
            ? 'bg-amber-400 text-amber-950'
            : natural === 'fumble'
              ? 'bg-red-500 text-white'
              : 'bg-violet-600 text-white dark:bg-violet-500'
          : 'bg-zinc-200 text-zinc-400 line-through dark:bg-zinc-700 dark:text-zinc-500',
      )}
      title={`d${sides}`}
    >
      <span className="dice-value">{value}</span>
    </span>
  )
}

function DiceRow({ result }: { result: DiceResult }) {
  const single = result.groups.length === 1 && result.groups[0]?.rolls.filter((r) => r.kept).length === 1
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {result.groups.map((group, gi) => (
        <span key={gi} className="inline-flex items-center gap-1">
          {gi > 0 && <span className="text-zinc-400">+</span>}
          {group.rolls.map((roll, ri) => (
            <Die
              key={ri}
              sides={group.sides}
              value={roll.value}
              kept={roll.kept}
              natural={single && roll.kept && group.sides === 20 ? result.natural : undefined}
            />
          ))}
        </span>
      ))}
      {result.modifier !== 0 && (
        <span className="text-sm font-medium text-zinc-500 tabular-nums">{signed(result.modifier)}</span>
      )}
    </div>
  )
}

/** 掷骰结果卡片（roll_dice） */
export function DiceCard({
  result,
  animate,
  ms = 800,
  compact,
}: {
  result: DiceResult
  animate: boolean
  ms?: number
  compact?: boolean
}) {
  const style = { '--dice-ms': `${animate ? ms : 0}ms` } as CSSProperties
  if (compact)
    return (
      <span
        style={style}
        className={cx(
          'dice-card inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1',
          animate && 'dice-animate',
        )}
      >
        <span className="font-mono text-xs text-zinc-500">{result.expression}</span>
        <DiceRow result={result} />
        <span className={cx('dice-total text-base font-semibold tabular-nums', outcomeTone(result.natural))}>
          = {result.total}
        </span>
        {result.reason && <span className="text-xs text-zinc-500">{result.reason}</span>}
      </span>
    )
  return (
    <div
      style={style}
      className={cx(
        'dice-card w-[min(320px,100%)] space-y-2 rounded-2xl bg-white/90 p-3 text-zinc-900 shadow-xl ring-1 ring-black/5 backdrop-blur dark:bg-zinc-900/90 dark:text-zinc-100 dark:ring-white/10',
        animate && 'dice-animate',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[13px] font-medium">{result.reason || t('掷骰')}</span>
        <span className="shrink-0 font-mono text-xs text-zinc-500">{result.expression}</span>
      </div>
      <DiceRow result={result} />
      <div className={cx('dice-total text-right text-2xl font-bold tabular-nums', outcomeTone(result.natural))}>
        {result.total}
        {result.natural && (
          <span className="ml-2 text-sm font-semibold">{result.natural === 'crit' ? t('自然 20') : t('自然 1')}</span>
        )}
      </div>
    </div>
  )
}

/** 检定结果卡片（ability_check、选项检定） */
export function CheckCard({
  result,
  animate,
  ms = 800,
  showDc,
  compact,
}: {
  result: CheckResult
  animate: boolean
  ms?: number
  showDc: boolean
  compact?: boolean
}) {
  const style = { '--dice-ms': `${animate ? ms : 0}ms` } as CSSProperties
  const name = checkLabel(result)
  const dc = showDc && result.dc !== null ? t('DC {dc}', { dc: result.dc }) : ''
  const outcome = outcomeText(result.outcome)
  if (compact)
    return (
      <span
        style={style}
        className={cx(
          'dice-card inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1',
          animate && 'dice-animate',
        )}
      >
        <span className="text-[13px] font-medium">
          {t('{who}的{check}', { who: result.who, check: name })}
          {dc && <span className="ml-1 font-normal text-zinc-500">{dc}</span>}
        </span>
        <DiceRow result={result.roll} />
        <span className="text-sm text-zinc-500 tabular-nums">{signed(result.bonus)}</span>
        <span className={cx('dice-total text-base font-semibold tabular-nums', outcomeTone(result.outcome))}>
          = {result.total}
          {outcome && <span className="ml-1.5 text-[13px]">{outcome}</span>}
        </span>
      </span>
    )
  return (
    <div
      style={style}
      className={cx(
        'dice-card w-[min(340px,100%)] space-y-2 rounded-2xl bg-white/90 p-3 text-zinc-900 shadow-xl ring-1 ring-black/5 backdrop-blur dark:bg-zinc-900/90 dark:text-zinc-100 dark:ring-white/10',
        animate && 'dice-animate',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[13px] font-medium">
          {t('{who}的{check}', { who: result.who, check: name })}
        </span>
        {dc && <span className="shrink-0 rounded bg-zinc-100 px-1.5 text-xs font-semibold dark:bg-zinc-800">{dc}</span>}
      </div>
      <div className="flex items-center gap-2">
        <DiceRow result={result.roll} />
        <span className="text-sm text-zinc-500 tabular-nums" title={t('属性调整值与熟练加值')}>
          {signed(result.bonus)}
        </span>
      </div>
      <div className="dice-total flex items-baseline justify-between gap-2">
        <span className={cx('text-lg font-bold', outcomeTone(result.outcome))}>{outcome}</span>
        <span className={cx('text-2xl font-bold tabular-nums', outcomeTone(result.outcome))}>{result.total}</span>
      </div>
      {result.source === 'none' && <p className="text-[11px] text-zinc-400">{t('没有找到属性，按 +0 计算')}</p>}
    </div>
  )
}
