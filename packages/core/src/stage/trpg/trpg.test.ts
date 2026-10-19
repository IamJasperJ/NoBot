import { describe, expect, test } from 'bun:test'
import { characterSheetSchema, type StageOp } from '@ai-parter/shared'
import { applyMacros, type MacroContext, rollDice as macroRoll } from '../../prompt/macros'
import { applyStageOps, emptyStage, parseStageMessage, resolveCombatStart, toDisplayText } from '../index'
import { abilityModifier, describeCheck, formatDice, getRuleSystem, rollDice } from './index'

const sequence = (...values: number[]) => {
  let index = 0
  return () => values[index++ % values.length]!
}
const sheet = characterSheetSchema.parse({
  level: 5,
  abilities: { dex: 16, wis: 14 },
  skills: ['perception'],
  expertise: ['stealth'],
  saves: ['dex'],
})
const rules = getRuleSystem('dnd5e')!
const check = (skill: string, dc: number | null = 12) =>
  rules.check({ who: 'Alice', skill, dc }, sheet, {}, { crit: false }, () => 0.5)

describe('掷骰', () => {
  test('多项、符号、百分骰、空格与大小写', () => {
    expect(rollDice(' 1D20 + 1d4 + 3 ', () => 0.5)?.total).toBe(17)
    expect(rollDice('2d6-1', () => 0)?.total).toBe(1)
    expect(rollDice('d20', () => 0.99)?.total).toBe(20)
    expect(rollDice('d%', () => 0.99)?.total).toBe(100)
    expect(rollDice('-d6+2-d4', () => 0)?.total).toBe(0)
  })
  test.each([
    ['kh3', 15],
    ['kl1', 1],
    ['dh1', 10],
    ['dl1', 15],
  ])('%s', (suffix, total) => {
    const result = rollDice(`4d6${suffix}`, sequence(0, 0.4, 0.9, 0.99))!
    expect(result.total).toBe(total)
    expect(formatDice(result)).toContain('~~')
  })
  test('稳定处理相同点数', () => {
    expect(rollDice('2d20kh1', () => 0.5)?.groups[0]?.rolls).toEqual([
      { value: 11, kept: true },
      { value: 11, kept: false },
    ])
  })
  test.each(['adv', 'advantage', 'dis', 'disadvantage'])('优势劣势别名 %s', (alias) => {
    const result = rollDice(`1d20 ${alias}`, sequence(0, 0.99))!
    expect(result.total).toBe(alias.startsWith('adv') ? 20 : 1)
    expect(result.advantage).toBe(alias.startsWith('adv') ? 'advantage' : 'disadvantage')
  })
  test('自然点数只看唯一计入的 d20', () => {
    expect(rollDice('2d20kh1+3', sequence(0, 0.99))?.natural).toBe('crit')
    expect(rollDice('d20+d4', () => 0)?.natural).toBe('fumble')
    expect(rollDice('2d20', () => 0.99)?.natural).toBeUndefined()
    expect(rollDice('d20+d20', () => 0)?.natural).toBeUndefined()
    expect(rollDice('d20kh0', () => 0)?.natural).toBeUndefined()
  })
  test.each([
    '',
    'bad',
    '0d6',
    '101d6',
    'd0',
    'd1',
    'd1001',
    '4d6kh5',
    '1d6++2',
    'd6+',
    '1.5d6',
    'd6*2',
    '2d6adv',
    Array(21).fill('d6').join('+'),
    '9007199254740992',
  ])('非法表达式不消耗随机数 %s', (expr) => {
    expect(
      rollDice(expr, () => {
        throw new Error('非法输入不应掷骰')
      }),
    ).toBeNull()
  })
  test('合法上限与零保留', () => {
    expect(rollDice('100d1000', () => 0)?.total).toBe(100)
    expect(rollDice(Array(20).fill('d2').join('+'), () => 0)?.total).toBe(20)
    expect(rollDice('2d6dl2', () => 0)?.total).toBe(0)
  })
})

describe('D&D 5e', () => {
  test('调整值、等级熟练、专精、显式熟练', () => {
    expect([1, 9, 10, 16, 20].map(abilityModifier)).toEqual([-5, -1, 0, 3, 5])
    expect(check('perception').bonus).toBe(5)
    expect(check('stealth').bonus).toBe(9)
    expect(check('dex save').bonus).toBe(6)
    expect(
      rules.check(
        { who: 'Alice', skill: 'perception', dc: 1 },
        { ...sheet, proficiency: 0 },
        {},
        { crit: false },
        () => 0,
      ).bonus,
    ).toBe(2)
  })
  test.each(['Sleight of Hand', 'sleight_of_hand', '巧手'])('技能别名 %s', (name) => {
    expect(check(name)).toMatchObject({ skill: 'sleight_of_hand', ability: 'dex', kind: 'skill', bonus: 3 })
  })
  test.each(['dex save', '敏捷豁免', 'Dexterity saving throw'])('豁免别名 %s', (name) => {
    expect(check(name)).toMatchObject({ ability: 'dex', kind: 'save', bonus: 6 })
  })
  test.each(['str', 'Strength', '力量'])('属性别名 %s', (name) => {
    expect(check(name)).toMatchObject({ ability: 'str', kind: 'ability', bonus: 0 })
  })
  test.each(['察觉', 'Perception', 'perception'])('察觉别名 %s', (name) => {
    expect(check(name)).toMatchObject({ ability: 'wis', kind: 'skill', bonus: 5 })
  })
  test.each(['力量', 'STR', 'str'])('会话属性回退 %s', (key) => {
    const input = { who: 'Alice', skill: 'athletics', dc: 12 }
    expect(rules.check(input, null, { [`Alice.${key}`]: 18 }, { crit: false }, () => 0)).toMatchObject({
      bonus: 4,
      source: 'vars',
    })
    expect(rules.check(input, sheet, { [`Alice.${key}`]: 18 }, { crit: false }, () => 0)).toMatchObject({
      bonus: 0,
      source: 'sheet',
    })
  })
  test('英文约定键优先于旧别名，NPC 熟练按约定变量读取', () => {
    expect(
      rules.check(
        { who: 'player', skill: 'perception', dc: 10 },
        null,
        {
          'player.wis': 18,
          'player.WIS': 10,
          'player.感知': 8,
          'player.skills': ['perception'],
          'player.proficiencyBonus': 2,
        },
        { crit: false },
        () => 0,
      ).bonus,
    ).toBe(6)
  })
  test('未知技能与属性缺失', () => {
    expect(check('mystery')).toMatchObject({
      skill: 'mystery',
      ability: 'str',
      bonus: 0,
      source: 'none',
      kind: 'ability',
    })
    expect(check('Dexterity mystery')).toMatchObject({ ability: 'dex', bonus: 0, source: 'none' })
    expect(
      rules.check({ who: 'Alice', skill: 'str', dc: 12 }, null, { 'Alice.力量': '18' }, { crit: false }, () => 0)
        .source,
    ).toBe('none')
  })
  test('DC 与 crit 开关', () => {
    const run = (crit: boolean, value: number, dc: number | null) =>
      rules.check({ who: 'Alice', skill: 'str', dc }, sheet, {}, { crit }, () => value)
    expect(run(true, 0.99, 100)).toMatchObject({ success: true, outcome: 'crit_success', margin: -80 })
    expect(run(false, 0.99, 100)).toMatchObject({ success: false, outcome: 'fail' })
    expect(run(true, 0, 0)).toMatchObject({ success: false, outcome: 'crit_fail' })
    expect(run(false, 0, 0)).toMatchObject({ success: true, outcome: 'success' })
    expect(run(true, 0.99, null)).toMatchObject({ success: null, margin: null, outcome: 'crit_success' })
    expect(run(false, 0.5, null)).toMatchObject({ success: null, margin: null, outcome: null })
    expect(run(false, 0.5, 11).success).toBe(true)
  })
  test('中毒劣势、抵消、会话状态覆盖', () => {
    for (const condition of ['中毒', 'poisoned']) {
      const poisoned = { ...sheet, conditions: [condition] }
      const run = (advantage?: 'advantage' | 'disadvantage', vars = {}) =>
        rules.check(
          { who: 'Alice', skill: 'dex', dc: null, advantage },
          poisoned,
          vars,
          { crit: false },
          sequence(0.8, 0.1),
        )
      expect(run().roll).toMatchObject({ total: 3, advantage: 'disadvantage' })
      expect(run('advantage').roll).toMatchObject({ total: 17 })
      expect(run('advantage').roll.advantage).toBeUndefined()
      expect(run('disadvantage').roll.total).toBe(3)
      expect(run(undefined, { 'Alice.conditions': [] }).roll.total).toBe(17)
    }
    expect(
      rules.check(
        { who: 'Alice', skill: 'dex', dc: null, advantage: 'advantage' },
        sheet,
        {},
        { crit: false },
        sequence(0, 0.99),
      ).roll.total,
    ).toBe(20)
  })
  test('先攻、英文说明、初始变量复制、未实现系统', () => {
    expect(rules.initiative({ name: 'Alice', sheet, vars: {} }, () => 0)).toBe(4)
    expect(rules.initiative({ name: 'Alice', sheet: null, vars: { 'Alice.敏捷': 18 } }, () => 0)).toBe(5)
    const vars = rules.initVars('Alice', sheet)
    expect(vars).toMatchObject({
      'Alice.hp': 10,
      'Alice.maxHp': 10,
      'Alice.conditions': [],
      'Alice.dex': 16,
      'Alice.proficiencyBonus': 3,
      'Alice.skills': ['perception'],
    })
    ;(vars['Alice.conditions'] as string[]).push('poisoned')
    expect(sheet.conditions).toEqual([])
    expect(rules.describe('Alice', sheet, { 'Alice.hp': 4 })).toContain('HP 4/10')
    expect(rules.describe('Alice', sheet, {})).toContain('DEX 16 (+3)')
    expect(describeCheck(check('perception'))).toBe(
      '[Check] Alice — Perception (WIS) DC 12: rolled 11 + 5 = 16 → success',
    )
    expect(getRuleSystem('coc7')).toBeNull()
  })
})

describe('舞台战斗', () => {
  const opts = { knownNames: [], vars: {}, inline: false, mvu: false }
  test.each([
    '<combat start: A, B， C>',
    '<combat start who="A,B， C">',
    '<combat action="start" who="A,B， C" />',
    '<COMBAT START： A,B，C>',
  ])('解析 %s', (text) => {
    const stage = parseStageMessage(text, opts).stage
    expect(stage.ops).toEqual([{ op: 'combat', action: 'start', who: ['A', 'B', 'C'] }])
    expect(stage.beats[0]).toMatchObject({ kind: 'stage' })
    expect(toDisplayText(text, { knownNames: [], speaker: 'plain' })).toBe('')
  })
  test('next / end、先攻稳定排序、回合推进、不修改输入', () => {
    const ops = parseStageMessage('<combat start: A,B,C><combat next><combat end>', opts).stage.ops
    expect(ops.slice(1)).toEqual([
      { op: 'combat', action: 'next' },
      { op: 'combat', action: 'end' },
    ])
    const start = resolveCombatStart(ops[0]!, (name) => (name === 'A' ? 1 : 10))
    const state = applyStageOps(emptyStage(), [start])
    expect(state.combat?.order.map((actor) => actor.name)).toEqual(['B', 'C', 'A'])
    const next: StageOp = { op: 'combat', action: 'next' }
    expect(applyStageOps(state, [next]).combat?.turn).toBe(1)
    expect(applyStageOps(state, [next, next, next]).combat).toMatchObject({ round: 2, turn: 0 })
    expect(state.combat?.turn).toBe(0)
    expect(applyStageOps(state, [{ op: 'scene', bg: 'forest' }]).combat).toEqual(state.combat)
    expect(applyStageOps(state, [{ op: 'combat', action: 'end' }]).combat).toBeUndefined()
    expect(applyStageOps(emptyStage(), [next, { op: 'combat', action: 'end' }])).toEqual(emptyStage())
    expect(
      resolveCombatStart(start, () => {
        throw new Error('不应重掷')
      }),
    ).toBe(start)
    expect(resolveCombatStart(next, () => 1)).toBe(next)
    expect(applyStageOps(emptyStage(), [ops[0]!]).combat?.order.map((actor) => actor.initiative)).toEqual([0, 0, 0])
  })
})

test('宏保持数字返回值、确定性和无效宏原文', () => {
  expect(macroRoll('2d6+3', () => 0)).toBe(5)
  expect(macroRoll('bad', () => 0)).toBeNull()
  const ctx: MacroContext = { char: 'A', user: 'B', now: new Date(0), seed: 'fixed' }
  expect(applyMacros('{{roll:1d20}}', ctx)).toBe(applyMacros('{{roll:1d20}}', ctx))
  expect(applyMacros('{{roll:bad}}', ctx)).toBe('{{roll:bad}}')
  expect(applyMacros('{{roll:1d20}}', ctx)).toMatch(/^\d+$/)
})
