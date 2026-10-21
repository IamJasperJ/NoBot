import { expect, test } from 'bun:test'
import { lineDeliverySchema } from '@nobot/shared'
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
  expect(toDisplayText('a<breath/>b<unknown/>', { ...opts, speaker: 'none' })).toBe('ab<unknown/>')
  expect(parseCues('a<breath/>b')).toEqual({ text: 'ab', cues: [{ at: 1, cue: 'breath' }] })
})

test('HTTP 逐句覆盖不填入默认值，避免覆盖基础演绎的其余字段', () => {
  expect(lineDeliverySchema.parse({ volume: 'whisper' })).toEqual({ volume: 'whisper' })
  expect(lineDeliverySchema.parse({})).toEqual({})
})
