import {
  ABILITIES,
  type Ability,
  type CharacterSheet,
  characterSheetSchema,
  DND5E_SKILLS,
  type Dnd5eSkill,
} from '@ai-parter/shared'
import { TextAreaField } from '../../components/form'
import { Button, cx, inputClass } from '../../components/ui'
import { t } from '../../i18n'
import { abilityLabel, signed, skillLabel } from './labels'

const mod = (score: number) => Math.floor((score - 10) / 2)
const autoProficiency = (level: number) => 2 + Math.floor((level - 1) / 4)
const SKILLS = Object.keys(DND5E_SKILLS) as Dnd5eSkill[]

/**
 * 跑团属性卡（D&D 5e）编辑器：角色编辑页和人设编辑页共用。value 为 null 时只显示「添加属性卡」按钮。
 * 受控组件，所有修改都通过 onChange 交回整份卡。
 */
export function SheetEditor({
  value,
  onChange,
  disabled,
  owner,
}: {
  value: CharacterSheet | null
  onChange: (sheet: CharacterSheet | null) => void
  disabled?: boolean
  /** 说明文字里用：「这个角色」/「你」 */
  owner: 'character' | 'persona'
}) {
  if (!value)
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-zinc-300 px-3 py-3 dark:border-zinc-700">
        <p className="min-w-0 flex-1 text-[13px] text-zinc-500">
          {owner === 'persona'
            ? t('给你的人设加一张 D&D 5e 属性卡，跑团时检定、先攻和 HP 都按它计算。')
            : t('给这个角色加一张 D&D 5e 属性卡，作为队友或固定 NPC 参与检定和战斗。')}
        </p>
        <Button size="sm" disabled={disabled} onClick={() => onChange(characterSheetSchema.parse({}))}>
          {t('添加属性卡')}
        </Button>
      </div>
    )
  const sheet = value
  const set = <K extends keyof CharacterSheet>(key: K, next: CharacterSheet[K]) => onChange({ ...sheet, [key]: next })
  const prof = sheet.proficiency ?? autoProficiency(sheet.level)
  const skillBonus = (id: Dnd5eSkill) => {
    const base = mod(sheet.abilities[DND5E_SKILLS[id].ability])
    return base + (sheet.expertise.includes(id) ? prof * 2 : sheet.skills.includes(id) ? prof : 0)
  }
  // 点技能循环：不熟练 → 熟练 → 专精 → 不熟练
  const cycleSkill = (id: Dnd5eSkill) => {
    if (sheet.expertise.includes(id))
      onChange({
        ...sheet,
        expertise: sheet.expertise.filter((s) => s !== id),
        skills: sheet.skills.filter((s) => s !== id),
      })
    else if (sheet.skills.includes(id)) onChange({ ...sheet, expertise: [...sheet.expertise, id] })
    else onChange({ ...sheet, skills: [...sheet.skills, id] })
  }
  const toggleSave = (a: Ability) =>
    set('saves', sheet.saves.includes(a) ? sheet.saves.filter((s) => s !== a) : [...sheet.saves, a])
  const num = (v: string, min: number, max: number, fallback: number) => {
    const n = Number.parseInt(v, 10)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
  }
  const small = cx(inputClass, 'h-8 px-2 py-0 text-center text-[13px] tabular-nums')
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3">
      {/* 第一行：等级、HP、AC、速度、熟练加值、概要 */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">
        {(
          [
            ['level', t('等级'), 1, 20],
            ['hpMax', t('生命上限'), 1, 9999],
            ['ac', t('护甲等级'), 0, 50],
            ['speed', t('速度'), 0, 200],
          ] as const
        ).map(([key, label, min, max]) => (
          <label key={key} className="space-y-1">
            <span className="block text-xs text-zinc-500">{label}</span>
            <input
              className={small}
              inputMode="numeric"
              value={sheet[key]}
              onChange={(e) => set(key, num(e.target.value, min, max, sheet[key]))}
            />
          </label>
        ))}
        <label className="space-y-1">
          <span className="block text-xs text-zinc-500">{t('熟练加值')}</span>
          <input
            className={small}
            inputMode="numeric"
            placeholder={signed(autoProficiency(sheet.level))}
            value={sheet.proficiency ?? ''}
            title={t('留空按等级自动计算')}
            onChange={(e) => set('proficiency', e.target.value.trim() === '' ? null : num(e.target.value, 0, 10, prof))}
          />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="block text-xs text-zinc-500">{t('概要')}</span>
        <input
          className={cx(inputClass, 'h-8 py-0 text-[13px]')}
          value={sheet.summary}
          placeholder={t('例如：半精灵游荡者，混乱善良')}
          onChange={(e) => set('summary', e.target.value)}
        />
      </label>
      {/* 六维：分数 + 调整值，豁免熟练用右上角的小圆点切换 */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {ABILITIES.map((a) => {
          const score = sheet.abilities[a]
          const save = sheet.saves.includes(a)
          return (
            <div
              key={a}
              className="relative flex flex-col items-center gap-0.5 rounded-xl border border-zinc-200 px-1 pt-1.5 pb-1 dark:border-zinc-800"
            >
              <button
                type="button"
                onClick={() => toggleSave(a)}
                aria-pressed={save}
                title={save ? t('豁免熟练（点击取消）') : t('点击设为豁免熟练')}
                className={cx(
                  'absolute top-1 right-1 size-2.5 rounded-full border',
                  save ? 'border-violet-500 bg-violet-500' : 'border-zinc-300 dark:border-zinc-600',
                )}
              />
              <span className="text-[11px] font-medium text-zinc-500">{abilityLabel(a)}</span>
              <span className="text-lg leading-none font-bold tabular-nums">{signed(mod(score))}</span>
              <input
                aria-label={abilityLabel(a)}
                className="h-6 w-12 rounded-md bg-zinc-100 text-center text-[13px] tabular-nums outline-none focus:ring-2 focus:ring-violet-500 dark:bg-zinc-800"
                inputMode="numeric"
                value={score}
                onChange={(e) => set('abilities', { ...sheet.abilities, [a]: num(e.target.value, 1, 30, score) })}
              />
            </div>
          )
        })}
      </div>
      {/* 技能：点击在不熟练 / 熟练 / 专精之间切换 */}
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-zinc-500">{t('技能（点击切换：不熟练 → 熟练 → 专精）')}</span>
        </div>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-1">
          {SKILLS.map((id) => {
            const level = sheet.expertise.includes(id) ? 2 : sheet.skills.includes(id) ? 1 : 0
            return (
              <button
                key={id}
                type="button"
                onClick={() => cycleSkill(id)}
                className={cx(
                  'flex h-8 items-center gap-1.5 rounded-lg px-2 text-left text-[13px]',
                  level === 2
                    ? 'bg-violet-600 text-white'
                    : level === 1
                      ? 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200'
                      : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800',
                )}
                title={level === 2 ? t('专精') : level === 1 ? t('熟练') : t('不熟练')}
              >
                <span className="w-7 shrink-0 text-right font-semibold tabular-nums">{signed(skillBonus(id))}</span>
                <span className="min-w-0 flex-1 truncate">{skillLabel(id)}</span>
                <span className="shrink-0 text-[10px] opacity-60">{abilityLabel(DND5E_SKILLS[id].ability)}</span>
              </button>
            )
          })}
        </div>
      </div>
      <label className="block space-y-1">
        <span className="block text-xs text-zinc-500">{t('开局状态效果（每行一个）')}</span>
        <textarea
          className={cx(inputClass, 'min-h-14 text-[13px]')}
          value={sheet.conditions.join('\n')}
          onChange={(e) =>
            set(
              'conditions',
              e.target.value.split('\n').filter((line, i, all) => line !== '' || i === all.length - 1),
            )
          }
        />
      </label>
      <TextAreaField
        label={t('装备、法术与特性')}
        hint={t('会写进给模型的属性摘要')}
        value={sheet.notes}
        onChange={(notes) => set('notes', notes)}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (confirm(t('移除这张属性卡？'))) onChange(null)
          }}
        >
          {t('移除属性卡')}
        </Button>
      </div>
    </fieldset>
  )
}
