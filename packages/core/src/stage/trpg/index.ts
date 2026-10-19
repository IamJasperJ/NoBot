import type { CheckResult } from '@nobot/shared'
import { dnd5e } from './dnd5e'
import type { RuleSystem } from './types'

export function getRuleSystem(id: string): RuleSystem | null {
  return id === 'dnd5e' ? dnd5e : null
}

/** 用一行英文把检定的依据与结论交给模型。 */
export function describeCheck(result: CheckResult): string {
  const label = result.skill.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return `[Check] ${result.who} — ${label} (${result.ability.toUpperCase()})${result.dc === null ? '' : ` DC ${result.dc}`}: rolled ${result.roll.total} ${result.bonus < 0 ? '-' : '+'} ${Math.abs(result.bonus)} = ${result.total} → ${result.outcome ?? 'no DC'}`
}

export { formatDice, rollDice } from './dice'
export { abilityModifier } from './dnd5e'
export type { CheckInput, RuleSystem } from './types'
