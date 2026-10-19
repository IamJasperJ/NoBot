import {
  ABILITIES,
  ABILITY_LABELS,
  type Ability,
  type CharacterSheet,
  type CheckResult,
  DND5E_SKILLS,
} from '@ai-parter/shared'
import { rollDice } from './dice'
import type { RuleSystem } from './types'

const names: Record<Ability, string> = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
}
const normalize = (text: string): string => text.toLowerCase().replace(/[\s_-]/g, '')
const signed = (value: number): string => `${value >= 0 ? '+' : ''}${value}`
export const abilityModifier = (score: number): number => Math.floor((score - 10) / 2)
const proficiency = (sheet: CharacterSheet): number => sheet.proficiency ?? 2 + Math.floor((sheet.level - 1) / 4)

function parseSkill(text: string): { skill: string; kind: CheckResult['kind']; ability: Ability; known: boolean } {
  const normalized = normalize(text)
  for (const [id, skill] of Object.entries(DND5E_SKILLS)) {
    if (normalized === normalize(id) || normalized === skill.label)
      return { skill: id, kind: 'skill', ability: skill.ability, known: true }
  }
  const saving = /(?:savingthrow|save|豁免)$/.test(normalized)
  const base = normalized.replace(/(?:savingthrow|save|豁免)$/, '')
  const ability = ABILITIES.find((id) => [id, normalize(names[id]), ABILITY_LABELS[id]].includes(base))
  if (ability)
    return { skill: saving ? `${ability} save` : ability, kind: saving ? 'save' : 'ability', ability, known: true }
  // 未知技能保留原文；只猜属性用于展示，不给它套用属性或熟练加值，避免模型拼错时偷偷改变规则。
  const guess = ABILITIES.find((id) =>
    [id, normalize(names[id]), ABILITY_LABELS[id]].some((alias) => normalized.includes(alias)),
  )
  return { skill: text, kind: 'ability', ability: guess ?? 'str', known: false }
}

function attribute(
  name: string,
  ability: Ability,
  sheet: CharacterSheet | null,
  vars: Record<string, unknown>,
): { bonus: number; source: CheckResult['source'] } {
  if (sheet) return { bonus: abilityModifier(sheet.abilities[ability]), source: 'sheet' }
  for (const key of [ability, ability.toUpperCase(), ABILITY_LABELS[ability]]) {
    const value = vars[`${name}.${key}`]
    if (typeof value === 'number' && Number.isFinite(value)) return { bonus: abilityModifier(value), source: 'vars' }
  }
  return { bonus: 0, source: 'none' }
}

function conditions(name: string, sheet: CharacterSheet | null, vars: Record<string, unknown>): string[] {
  const value = vars[`${name}.conditions`] ?? sheet?.conditions ?? []
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export const dnd5e: RuleSystem = {
  id: 'dnd5e',
  check(input, sheet, vars, opts, random) {
    const parsed = parseSkill(input.skill)
    const attr = parsed.known
      ? attribute(input.who, parsed.ability, sheet, vars)
      : { bonus: 0, source: 'none' as const }
    let bonus = attr.bonus
    if (sheet && parsed.known) {
      if (parsed.kind === 'skill') {
        if (sheet.expertise.includes(parsed.skill)) bonus += proficiency(sheet) * 2
        else if (sheet.skills.includes(parsed.skill)) bonus += proficiency(sheet)
      } else if (parsed.kind === 'save' && sheet.saves.includes(parsed.ability)) bonus += proficiency(sheet)
    }
    if (!sheet && parsed.known && parsed.kind === 'skill') {
      const skills = vars[`${input.who}.skills`]
      const prof = vars[`${input.who}.proficiencyBonus`]
      if (Array.isArray(skills) && skills.includes(parsed.skill) && typeof prof === 'number' && Number.isFinite(prof)) {
        bonus += prof
      }
    }
    // 首发只处理中毒对检定的劣势，隐形等其他状态的效果留待后续规则扩展。
    const poisoned = conditions(input.who, sheet, vars).some((value) =>
      ['中毒', 'poisoned'].includes(value.trim().toLowerCase()),
    )
    const adv = input.advantage === 'advantage'
    const dis = input.advantage === 'disadvantage' || poisoned
    const advantage = adv === dis ? undefined : adv ? 'advantage' : 'disadvantage'
    const roll = rollDice(`1d20${advantage ? ` ${advantage}` : ''}`, random)!
    const total = roll.total + bonus
    const critical = opts.crit && roll.natural ? (roll.natural === 'crit' ? 'crit_success' : 'crit_fail') : null
    const success = input.dc === null ? null : critical ? critical === 'crit_success' : total >= input.dc
    return {
      who: input.who,
      skill: parsed.skill,
      kind: parsed.kind,
      ability: parsed.ability,
      dc: input.dc,
      roll,
      bonus,
      total,
      success,
      margin: input.dc === null ? null : total - input.dc,
      outcome: critical ?? (success === null ? null : success ? 'success' : 'fail'),
      source: attr.source,
    }
  },
  initiative(actor, random) {
    return rollDice('d20', random)!.total + attribute(actor.name, 'dex', actor.sheet, actor.vars).bonus
  },
  describe(name, sheet, vars) {
    const abilities = ABILITIES.map(
      (id) => `${id.toUpperCase()} ${sheet.abilities[id]} (${signed(abilityModifier(sheet.abilities[id]))})`,
    ).join(', ')
    return [
      `${name}: D&D 5e, level ${sheet.level}${sheet.summary ? `, ${sheet.summary}` : ''}.`,
      abilities,
      `Proficiency ${signed(proficiency(sheet))}; skills: ${sheet.skills.join(', ') || 'none'}; expertise: ${sheet.expertise.join(', ') || 'none'}; saves: ${sheet.saves.join(', ') || 'none'}.`,
      `HP ${vars[`${name}.hp`] ?? sheet.hpMax}/${vars[`${name}.maxHp`] ?? sheet.hpMax}; AC ${sheet.ac}; speed ${sheet.speed}; conditions: ${conditions(name, sheet, vars).join(', ') || 'none'}.`,
      sheet.notes,
    ]
      .filter(Boolean)
      .join('\n')
  },
  initVars(name, sheet) {
    return {
      [`${name}.hp`]: sheet.hpMax,
      [`${name}.maxHp`]: sheet.hpMax,
      [`${name}.ac`]: sheet.ac,
      [`${name}.level`]: sheet.level,
      [`${name}.proficiencyBonus`]: proficiency(sheet),
      [`${name}.skills`]: [...sheet.skills],
      ...Object.fromEntries(ABILITIES.map((id) => [`${name}.${id}`, sheet.abilities[id]])),
      [`${name}.conditions`]: [...sheet.conditions],
    }
  },
}
