import type { CharacterSheet, CheckResult, RuleSystem as RuleSystemId } from '@nobot/shared'

export interface CheckInput {
  who: string
  skill: string
  dc: number | null
  advantage?: 'advantage' | 'disadvantage'
}

export interface RuleSystem {
  id: RuleSystemId
  check(
    input: CheckInput,
    sheet: CharacterSheet | null,
    vars: Record<string, unknown>,
    opts: { crit: boolean },
    random: () => number,
  ): CheckResult
  initiative(
    actor: { name: string; sheet: CharacterSheet | null; vars: Record<string, unknown> },
    random: () => number,
  ): number
  /** 把角色卡和当前变量渲染成给模型看的英文说明。 */
  describe(name: string, sheet: CharacterSheet, vars: Record<string, unknown>): string
  /** 可变状态独立复制，避免后续变量更新污染角色卡。 */
  initVars(name: string, sheet: CharacterSheet): Record<string, unknown>
}
