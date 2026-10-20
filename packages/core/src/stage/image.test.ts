import { expect, test } from 'bun:test'
import { EXPRESSIONS } from '@nobot/shared'
import {
  applyAlphaMask,
  EXPRESSION_TAGS,
  hasTransparentBackground,
  removeSpriteBackground,
  spritePrompt,
} from './image'

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

test('边界泛洪、外圈中位数、内部白色保留且不改变输入', () => {
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
  expect(result[(2 * size + 3) * 4 + 3]).toBe(255)
  expect(result[(3 * size + 3) * 4 + 3]).toBe(255)
  expect(rgba).toEqual(original)
  const near = new Uint8Array([255, 255, 255, 255, 230, 230, 230, 255, 255, 255, 255, 255])
  expect(removeSpriteBackground(near, 3, 1)[7]).toBe(0)
  expect(removeSpriteBackground(near, 3, 1, { inner: 0, outer: 60 })[7]).toBeGreaterThan(0)
  expect(() => removeSpriteBackground(near, 3, 2)).toThrow(RangeError)
})

function picture(size: number, bg: number[]) {
  const rgba = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) rgba.set([...bg, 255], i * 4)
  const pixel = (x: number, y: number, color: number[]) => rgba.set([...color, 255], (y * size + x) * 4)
  const rect = (x: number, y: number, w: number, h: number, color: number[]) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) pixel(i, j, color)
  }
  return { rgba, pixel, rect }
}

test('白底软阈值反解混色，外圈透明检测，遮罩保留原始 alpha', () => {
  const { rgba, rect, pixel } = picture(40, [255, 255, 255])
  rect(10, 6, 20, 30, [20, 40, 60])
  pixel(9, 15, [200, 210, 220])
  const out = removeSpriteBackground(rgba, 40, 40)
  const i = (15 * 40 + 9) * 4
  expect(out[i + 3]).toBeGreaterThan(0)
  expect(out[i + 3]).toBeLessThan(255)
  expect(out[i]).toBeLessThan(200)
  expect(hasTransparentBackground(rgba, 40, 40)).toBe(false)
  expect(hasTransparentBackground(out, 40, 40)).toBe(true)
  expect(applyAlphaMask(new Uint8Array([150, 150, 150, 128]), 1, 1, [0.5], [255, 255, 255])).toEqual(
    new Uint8Array([45, 45, 45, 64]),
  )
  expect(() => applyAlphaMask(rgba, 40, 40, [])).toThrow(RangeError)
})

test('绿幕封闭洞、三像素溢色带和绿色衣服内部', () => {
  const { rgba, rect, pixel } = picture(64, [0, 255, 0])
  rect(12, 8, 40, 48, [80, 90, 100])
  rect(20, 20, 8, 8, [0, 255, 0])
  rect(34, 20, 10, 15, [0, 180, 0])
  pixel(12, 30, [70, 150, 80])
  const out = removeSpriteBackground(rgba, 64, 64)
  expect(out[(22 * 64 + 22) * 4 + 3]).toBe(0)
  expect(out[(30 * 64 + 12) * 4 + 1]).toBeLessThanOrEqual(
    Math.max(out[(30 * 64 + 12) * 4]!, out[(30 * 64 + 12) * 4 + 2]!),
  )
  expect(out[(25 * 64 + 38) * 4 + 1]).toBe(180)
  expect(out[(25 * 64 + 38) * 4 + 3]).toBe(255)
})

test('白底封闭白色保留，碎点删除，最大连通块永远保留', () => {
  const { rgba, rect, pixel } = picture(100, [255, 255, 255])
  rect(30, 20, 40, 60, [0, 0, 0])
  rect(40, 30, 10, 10, [255, 255, 255])
  pixel(10, 10, [0, 0, 0])
  const out = removeSpriteBackground(rgba, 100, 100)
  expect(out[(35 * 100 + 45) * 4 + 3]).toBe(255)
  expect(out[(10 * 100 + 10) * 4 + 3]).toBe(0)
  expect(out[(25 * 100 + 35) * 4 + 3]).toBe(255)
})

test('绿幕提示词覆盖两种风格且不再包含白底', () => {
  for (const style of ['natural', 'tags'] as const) {
    const prompt = spritePrompt('blue hair', 'joy', '', style, 'green')
    expect(prompt).toContain('chroma')
    expect(prompt).not.toContain('white background')
  }
})
