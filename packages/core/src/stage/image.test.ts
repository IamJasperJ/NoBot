import { expect, test } from 'bun:test'
import { EXPRESSIONS } from '@ai-parter/shared'
import { EXPRESSION_TAGS, removeSpriteBackground, spritePrompt } from './image'

test('28 种表情都有英文可见标签，提示词包含立绘构图限制', () => {
  expect(Object.keys(EXPRESSION_TAGS).sort()).toEqual([...EXPRESSIONS].sort())
  for (const expression of EXPRESSIONS) {
    expect(EXPRESSION_TAGS[expression]).toMatch(/^[a-z, ]+$/)
    expect(spritePrompt('blue hair', expression, 'coat', 'tags')).toContain(
      'full body, standing, simple white background, no other characters',
    )
  }
  expect(spritePrompt('Blue hair', 'joy', 'coat', 'natural')).toContain('smile, happy')
  expect(spritePrompt('Blue hair', 'custom_face', '', 'natural')).toContain('custom face')
  expect(spritePrompt('Blue hair', 'constructor', '', 'tags')).toContain('constructor')
})

test('边界泛洪、四角中位数、内部白色保留、一像素羽化且不改变输入', () => {
  const size = 9
  const rgba = new Uint8Array(size * size * 4).fill(255)
  for (let y = 2; y <= 6; y++)
    for (let x = 2; x <= 6; x++) {
      const index = (y * size + x) * 4
      rgba[index] = 20
      rgba[index + 1] = 30
      rgba[index + 2] = 40
    }
  const center = (4 * size + 4) * 4
  rgba.set([255, 255, 255, 255], center)
  // 一角被污染时，其他三角仍应决定白色背景。
  rgba.set([0, 0, 0, 255], 0)
  const original = new Uint8Array(rgba)
  const result = removeSpriteBackground(rgba, size, size)
  expect(result[4 + 3]).toBe(0)
  expect(result[center + 3]).toBe(255)
  expect(result[(2 * size + 3) * 4 + 3]).toBeLessThan(255)
  expect(result[(3 * size + 3) * 4 + 3]).toBe(255)
  expect(rgba).toEqual(original)
  const near = new Uint8Array([255, 255, 255, 255, 230, 230, 230, 255, 255, 255, 255, 255])
  expect(removeSpriteBackground(near, 3, 1)[7]).toBe(0)
  expect(removeSpriteBackground(near, 3, 1, 0)[7]).toBeGreaterThan(0)
  expect(() => removeSpriteBackground(near, 3, 2)).toThrow(RangeError)
})
