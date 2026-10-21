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
  bgm: [],
  sfx: [],
  schema: { affection: { type: 'number' } },
  rules: {},
  vars: { affection: 5 },
  valuesInPrompt: true,
}

test.each(['shorthand', 'xml'] as const)('表情说明与提醒要求按实际说话人归属台词：%s', (style) => {
  const instructions = renderDirectiveInstructions({ ...input, style })
  expect(instructions).toContain('The name must identify the character actually speaking.')
  expect(instructions).toContain('Never attribute another character’s lines to yourself or the card')
  expect(instructions).toContain('give unnamed NPCs short descriptive names (e.g. Hooded traveler)')
  const reminder = renderDirectiveReminder({ ...input, style, reminderTemplate: '' })
  expect(reminder).toContain('Name the actual speaker, never yourself or the card for someone else’s lines')
  expect(reminder).toContain('use short descriptive names for unnamed NPCs')
  const disabled = { ...input, style, kinds: [] }
  expect(renderDirectiveInstructions(disabled)).not.toContain('The name must identify')
  expect(renderDirectiveReminder({ ...disabled, reminderTemplate: '' })).not.toContain('Name the actual speaker')
})

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

test('音频清单、空行删除和示例按可用名字生成', () => {
  const audio = { ...input, kinds: ['audio'] as const, lists: ['audio'] as const }
  const render = (bgm: string[], sfx: string[]) =>
    renderDirectiveInstructions({ ...audio, kinds: [...audio.kinds], lists: [...audio.lists], bgm, sfx })
  expect(render(['Night'], ['Bell'])).toContain('Available music: Night')
  expect(render(['Night'], ['Bell'])).toContain('Available sound effects: Bell')
  expect(render(['Night'], ['Bell'])).toContain('<bgm name="Night" />')
  expect(render([], ['Bell'])).toContain('<sfx name="Bell" />')
  expect(render([], [])).not.toContain('Available music:')
  expect(render([], [])).not.toContain('Available sound effects:')
  expect(render([], [])).not.toContain('<sfx name="bell" />')
  const hidden = renderDirectiveInstructions({
    ...input,
    kinds: ['audio'],
    lists: [],
    bgm: ['Night'],
    sfx: ['Bell'],
    template: '{{vn_bgm}}\n{{vn_sfx}}\n{{vn_example}}',
  })
  expect(hidden).not.toContain('Night')
  expect(hidden).not.toContain('Bell')
})

test.each(['shorthand', 'xml'] as const)('丰富演绎说明和示例只按服务端标志启用：%s', (style) => {
  for (const richDelivery of [false, undefined]) {
    const prompt = renderDirectiveInstructions({ ...input, style, richDelivery })
    expect(prompt).not.toContain('delivery hints')
    expect(prompt).not.toContain('<sigh/>')
    expect(prompt).not.toContain('tone=')
  }
  const prompt = renderDirectiveInstructions({ ...input, style, richDelivery: true })
  expect(prompt).toContain('delivery hints')
  for (const cue of ['laugh', 'chuckle', 'sigh', 'gasp', 'breath', 'sob', 'cough', 'clear-throat'])
    expect(prompt).toContain(`<${cue}/>`)
  expect(prompt).toContain('at most 1–2 cues per sentence')
  expect(prompt).toContain('Do not turn action descriptions into sound tags')
  expect(prompt).toContain(
    style === 'xml' ? 'tone="whispering, holding back tears"' : '[joy|whispering, holding back tears]',
  )
  const reminder = renderDirectiveReminder({ ...input, style, richDelivery: true, reminderTemplate: '' })
  expect(reminder).toContain('delivery hints')
  expect(renderDirectiveInstructions({ ...input, style, richDelivery: true, kinds: ['cast'] })).not.toContain(
    'delivery hints',
  )
})
