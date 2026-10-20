import { expect, test } from 'bun:test'
import { EXPRESSIONS } from '@nobot/shared'
import { expressionTone, type Tone } from './expression-tone'

test('28 种表情全部映射，以及空值、未知值和标准语气', () => {
  const expected: Record<(typeof EXPRESSIONS)[number], Tone> = {
    admiration: 'happy',
    amusement: 'happy',
    anger: 'angry',
    annoyance: 'angry',
    approval: 'happy',
    caring: 'happy',
    confusion: 'surprised',
    curiosity: 'surprised',
    desire: 'happy',
    disappointment: 'sad',
    disapproval: 'angry',
    disgust: 'disgusted',
    embarrassment: 'sad',
    excitement: 'happy',
    fear: 'fearful',
    gratitude: 'happy',
    grief: 'sad',
    joy: 'happy',
    love: 'happy',
    nervousness: 'fearful',
    optimism: 'happy',
    pride: 'happy',
    realization: 'surprised',
    relief: 'happy',
    remorse: 'sad',
    sadness: 'sad',
    surprise: 'surprised',
    neutral: 'neutral',
  }
  expect(Object.keys(expected).sort()).toEqual([...EXPRESSIONS].sort())
  for (const expression of EXPRESSIONS) expect(expressionTone(expression)).toBe(expected[expression])
  for (const value of [undefined, '', 'unknown', '<instruction>']) expect(expressionTone(value)).toBe('neutral')
  expect(expressionTone(' JOY ')).toBe('happy')
  expect(expressionTone('calm')).toBe('calm')
})
