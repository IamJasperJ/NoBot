import { describe, expect, test } from 'bun:test'
import { applyMacros, hashString, type MacroContext, rollDice, seededRandom } from './macros'

const context: MacroContext = {
  char: '角色',
  user: '用户',
  group: '甲、乙',
  lastChatMessage: '最后内容',
  now: new Date('2026-01-02T03:04:00Z'),
  seed: '固定种子',
}

describe('宏扩展及兼容性', () => {
  test('新增宏大小写不敏感，original 未提供时保持原文', () => {
    expect(applyMacros('{{GROUP}}/{{LastChatMessage}}/{{original}}', context)).toBe('甲、乙/最后内容/{{original}}')
    expect(applyMacros('{{Original}}', { ...context, original: '原文' })).toBe('原文')
  })
  test('outlet 名字区分大小写并 trim，缺失内容为空', () => {
    expect(
      applyMacros('{{OUTLET:: A }}/{{outlet::a}}/{{outlet::不存在}}', { ...context, outlets: { A: '内容' } }),
    ).toBe('内容//')
  })
  test('extra 小写查找，参数保留 ::，内置宏优先', () => {
    const extra = { echo: (arg: string) => `[${arg}]`, char: () => '覆盖', random: () => '覆盖' }
    expect(applyMacros('{{ECHO}}/{{Echo::甲::乙}}/{{char}}/{{random::唯一}}/{{unknown}}', { ...context, extra })).toBe(
      '[]/[甲::乙]/角色/唯一/{{unknown}}',
    )
  })
  test('旧宏、注释、未知宏以及无宏正文保持行为', () => {
    expect(applyMacros('<BOT>/<CHAR>/<USER>/{{char}}/{{USER}}{{newline}}{{// 注释}}{{未知}}', context)).toBe(
      '角色/角色/用户/角色/用户\n{{未知}}',
    )
    expect(applyMacros('原文', context)).toBe('原文')
    const text = '{{random::a::b::c}} {{random:a,b,c}} {{roll:2d6+3}}'
    expect(applyMacros(text, context)).toBe(applyMacros(text, context))
  })
  test('哈希、随机数和掷骰仍然确定', () => {
    expect(hashString('固定')).toBe(hashString('固定'))
    expect(seededRandom(123)()).toBe(seededRandom(123)())
    expect(rollDice('2d6+3', () => 0)).toBe(5)
    expect(rollDice('d100', () => 0.99)).toBe(100)
    expect(rollDice('bad', () => 0)).toBeNull()
  })
})

test('扩展宏可使用以 random/roll 开头的普通名字，原型键不会被当成宏', () => {
  const extra = { randomize: (arg: string) => `随机扩展${arg}`, rollover: () => '掷骰扩展' }
  expect(applyMacros('{{randomize::参数}}/{{rollover}}/{{constructor}}/{{toString}}', { ...context, extra })).toBe(
    '随机扩展参数/掷骰扩展/{{constructor}}/{{toString}}',
  )
  expect(applyMacros('{{outlet::constructor}}/{{outlet::toString}}', { ...context, outlets: {} })).toBe('/')
})

test('阶段宏保留变量名大小写，缺失时为空且优先于扩展宏', () => {
  expect(
    applyMacros('{{STAGE:: Alice.affection }}/{{stage::alice.affection}}/{{stage::missing}}', {
      ...context,
      stages: { 'Alice.affection': 'Lovers' },
      extra: { stage: () => '覆盖' },
    }),
  ).toBe('Lovers//')
  expect(applyMacros('{{stage::constructor}}', context)).toBe('')
})
