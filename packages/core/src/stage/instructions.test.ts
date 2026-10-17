import { expect, test } from 'bun:test'
import {
  type InstructionsInput,
  parseStageMessage,
  renderDirectiveInstructions,
  renderDirectiveReminder,
} from './index'

const input: InstructionsInput = {
  template: '',
  style: 'shorthand',
  kinds: ['scene', 'cast', 'expression', 'state', 'choices'],
  lists: ['outfits'],
  cast: ['Alice', 'Bob'],
  outfits: { Alice: ['', 'casual', 'casual', 'swimsuit'], Bob: ['armor'] },
  choicesMode: 'always',
  expressions: ['joy', 'neutral'],
  backgrounds: ['Garden at dusk'],
  schema: { affection: { type: 'number' } },
  rules: {},
  vars: { affection: 5 },
  valuesInPrompt: true,
}

test('服装清单去重、忽略默认服装，并遵循 lists 开关', () => {
  expect(renderDirectiveInstructions(input)).toContain('Available outfits: Alice: casual, swimsuit; Bob: armor')
  expect(renderDirectiveInstructions({ ...input, lists: [] })).not.toContain('Available outfits:')
  expect(renderDirectiveInstructions({ ...input, outfits: { Alice: [''] } })).not.toContain('Available outfits:')
})

test.each(['shorthand', 'xml'] as const)('示例 %s 使用传入清单并可被解析器读取', (style) => {
  const result = renderDirectiveInstructions({ ...input, style, template: '{{vn_example}}' })
  expect(result.split('\n').length).toBeGreaterThanOrEqual(4)
  expect(result.split('\n').length).toBeLessThanOrEqual(10)
  const parsed = parseStageMessage(result, { knownNames: input.cast, vars: {}, inline: true, mvu: false })
  expect(parsed.stage.ops).toContainEqual({
    op: 'scene',
    bg: 'Garden at dusk',
    time: 'evening',
  })
  expect(parsed.stage.ops).toContainEqual({ op: 'show', who: 'Alice', at: 'center', outfit: 'casual' })
  expect(parsed.stage.choices).toHaveLength(2)
  expect(parsed.varsPatch).toEqual({ affection: 2 })
  const fallback = renderDirectiveInstructions({
    ...input,
    style,
    template: '{{vn_example}}',
    cast: [],
    outfits: {},
    backgrounds: [],
    expressions: ['custom', 'other'],
  })
  expect(fallback).toContain('Alice')
  expect(fallback).toContain('Classroom')
  expect(fallback).toContain('custom')
  expect(fallback).toContain('other')
})

test('提醒按启用 kinds、风格与选项模式渲染，并删除空占位符整行', () => {
  const reminder = renderDirectiveReminder({ ...input, reminderTemplate: '' })
  expect(reminder).toContain('EVERY spoken sentence')
  expect(reminder).toContain('End EVERY reply')
  expect(reminder).not.toContain('{{')
  expect(reminder.split('\n').length).toBeLessThanOrEqual(10)
  const auto = renderDirectiveReminder({
    ...input,
    style: 'xml',
    kinds: ['expression', 'choices'],
    choicesMode: 'auto',
    reminderTemplate: '{{vn_rules}}',
  })
  expect(auto).toContain('<say who=')
  expect(auto).toContain('When the player faces a choice')
  expect(auto).not.toContain('<scene')
  expect(renderDirectiveReminder({ ...input, kinds: [], reminderTemplate: 'Keep\nRules: {{vn_rules}}' })).toBe('Keep')
  expect(renderDirectiveInstructions({ ...input, choicesMode: 'auto' })).toContain(
    'Only when the player faces a choice',
  )
})
