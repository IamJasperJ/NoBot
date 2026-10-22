import { expect, test } from 'bun:test'
import { CUES, lineDeliverySchema } from '@nobot/shared'
import { parseCues, parseLineDelivery, parseStageMessage, toDisplayText } from './index'

const opts = { knownNames: ['Alice'], vars: {}, inline: false, mvu: false }

test.each([
  '<say who="Alice" expr="sadness" tone="very whispering, holding back tears">Hi<sigh /> there<LAUGH/></say>',
  'Alice[sadness|very whispering, holding back tears]：Hi<sigh /> there<LAUGH/>',
])('两种语法保留声音原文和偏移，显示时隐藏演绎：%s', (source) => {
  const beat = parseStageMessage(source, opts).stage.beats[0]
  expect(beat).toEqual({
    kind: 'line',
    speaker: 'Alice',
    expression: 'sadness',
    text: 'Hi<sigh /> there<LAUGH/>',
    delivery: { volume: 'whisper', intensity: 3, direction: 'holding back tears' },
    cues: [
      { at: 2, cue: 'sigh' },
      { at: 8, cue: 'laugh' },
    ],
  })
  expect(toDisplayText(source, { ...opts, speaker: 'bold' })).toBe('**Alice**：Hi there')
  expect(toDisplayText(source, { ...opts, speaker: 'none' })).toBe('Hi there')
  expect(toDisplayText(source, { ...opts, speaker: 'plain', streaming: true })).toBe('Alice：Hi there')
})

test('控制词大小写与单词边界、强弱和说明截断', () => {
  expect(parseLineDelivery('a little SHOUTING, in a hurry')).toEqual({
    intensity: 1,
    volume: 'shout',
    direction: 'in a hurry',
  })
  expect(parseLineDelivery('extremely yelling')).toEqual({ intensity: 3, volume: 'shout' })
  expect(parseLineDelivery('slightly whisper')).toEqual({ intensity: 1, volume: 'whisper' })
  expect(parseLineDelivery('every whisperingbird')).toEqual({ direction: 'every whisperingbird' })
  expect(parseLineDelivery('x'.repeat(130)).direction).toHaveLength(120)
})

test('没有标注时不增加字段，普通文本 cue 同样隐藏，其他尖括号保留', () => {
  expect(parseStageMessage('Alice[joy]：Hi', opts).stage.beats[0]).toEqual({
    kind: 'line',
    speaker: 'Alice',
    expression: 'joy',
    text: 'Hi',
  })
  expect(toDisplayText('a<breath/>b<unknown/>', { ...opts, speaker: 'none' })).toBe('ab')
  expect(parseCues('a<breath/>b')).toEqual({ text: 'ab', cues: [{ at: 1, cue: 'breath' }] })
})

test('HTTP 逐句覆盖不填入默认值，避免覆盖基础演绎的其余字段', () => {
  expect(lineDeliverySchema.parse({ volume: 'whisper' })).toEqual({ volume: 'whisper' })
  expect(lineDeliverySchema.parse({})).toEqual({})
})

test.each([
  ['普通。<whisper/>秘密。', '普通。秘密。'],
  ['Normal.<whisper/>Secret.', 'Normal.Secret.'],
  ['普通。<shout/>秘密。', '普通。秘密。'],
  ['Normal.<shout/>Secret.', 'Normal.Secret.'],
])('自闭合音量始终覆盖整条台词：%s', (source, text) => {
  expect(parseCues(source)).toEqual({ text, cues: [], volume: source.includes('whisper') ? 'whisper' : 'shout' })
})

test.each([
  ['普通。<whisper>秘密。</whisper>恢复。', '普通。秘密。恢复。', 3, 6],
  ['Normal.<whisper>Secret.</whisper>Back.', 'Normal.Secret.Back.', 7, 14],
])('成对作用域偏移使用纯正文，显示保留内部文字：%s', (source, text, start, end) => {
  expect(parseCues(source)).toEqual({ text, cues: [], spans: [{ start, end, volume: 'whisper' }] })
  expect(toDisplayText(`<say who="Alice">${source}</say>`, { ...opts, speaker: 'none' })).toBe(text)
})

test('只消费确切别名，括号文字、比较符、未知成对和舞台指令保留', () => {
  for (const alias of ['[whispers]', '[whispering]', '(whispering)', '[shouts]', '[shouting]', '(shouting)']) {
    expect(parseCues(`甲${alias}乙`).text).toBe('甲乙')
    expect(parseCues(`A${alias}B`).volume).toBe(alias.includes('whisp') ? 'whisper' : 'shout')
  }
  const literal =
    'a<b <3 （小声）(quietly) [aside] *whispers* <unknown>秘密</unknown> <say/> <cg/> <choices/> <combat/>'
  expect(parseCues(`${literal}<foobar/><word-word/>`).text).toBe(literal)
})

test('停顿默认、别名、整数范围及 cue 偏移', () => {
  expect(parseCues('甲<pause ms="500"/><inhale/>乙')).toEqual({
    text: '甲乙',
    cues: [{ at: 1, cue: 'inhale' }],
    pauses: [{ at: 1, ms: 500 }],
  })
  expect(parseCues('A<pause/>B[pause]C[short pause]D[long pause]E').pauses).toEqual([
    { at: 1, ms: 500 },
    { at: 2, ms: 500 },
    { at: 3, ms: 300 },
    { at: 4, ms: 1000 },
  ])
  expect(parseCues('甲<pause ms="0"/>乙<pause ms="999999999"/>丙').pauses).toEqual([
    { at: 1, ms: 1 },
    { at: 2, ms: 99990 },
  ])
})

test('中英文每种声音事件都消费且记录清理后的偏移', () => {
  for (const prefix of ['甲', 'A']) {
    for (const cue of CUES)
      expect(parseCues(`${prefix}<${cue}/>乙B`)).toEqual({ text: `${prefix}乙B`, cues: [{ at: 1, cue }] })
  }
  expect(parseCues('甲<pause ms="-1"/>乙<pause ms="oops"/>丙')).toEqual({ text: '甲乙丙', cues: [] })
})
