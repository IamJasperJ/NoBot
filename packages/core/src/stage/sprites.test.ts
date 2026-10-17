import { describe, expect, test } from 'bun:test'
import { extractExpressionLabel, pickSprite, spriteNameFromPath } from './index'

describe('立绘纯函数', () => {
  test('文件名与最后一层服装目录', () => {
    for (const [path, outfit, expression] of [
      ['joy.png', '', 'joy'],
      ['joy-1.png', '', 'joy'],
      ['joy.expressive.png', '', 'joy'],
      ['Joy_Smile.webp', '', 'joy_smile'],
      ['casual/joy.png', 'casual', 'joy'],
      ['pack/礼服/anger.gif', '礼服', 'anger'],
      ['casual\\joy.png', 'casual', 'joy'],
    ] as const)
      expect(spriteNameFromPath(path!)).toEqual({ outfit, expression })
    for (const path of ['.joy.png', '__MACOSX/joy.png', 'a/__MACOSX/b/joy.png', '开心.png', '-joy.png', '', 'a/'])
      expect(spriteNameFromPath(path)).toBeNull()
  })
  test('服装、默认服装、兜底、空结果以及稳定随机与避重', () => {
    const sprites = [
      { id: '1', outfit: '', expression: 'joy' },
      { id: '2', outfit: '', expression: 'joy' },
      { id: '3', outfit: 'casual', expression: 'joy' },
      { id: '4', outfit: '', expression: 'neutral' },
      { id: '5', outfit: 'casual', expression: 'neutral' },
    ]
    const opts = { expression: 'joy', outfit: 'casual', fallback: 'neutral', random: false, seed: 'message' }
    expect(pickSprite(sprites, opts)?.id).toBe('3')
    expect(pickSprite(sprites, { ...opts, outfit: 'other' })?.id).toBe('1')
    expect(pickSprite(sprites, { ...opts, expression: 'fear' })?.id).toBe('5')
    expect(pickSprite(sprites, { ...opts, expression: 'fear', outfit: 'other' })?.id).toBe('4')
    expect(pickSprite(sprites, { ...opts, expression: 'fear', fallback: '' })).toBeNull()
    expect(pickSprite([], opts)).toBeNull()
    expect(pickSprite(sprites, { ...opts, outfit: '', avoidId: '1' })?.id).toBe('2')
    expect(pickSprite(sprites, { ...opts, avoidId: '3' })?.id).toBe('3')
    const choices = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const random = { ...opts, outfit: '', random: true, seed: String(i) }
      const chosen = pickSprite(sprites, random)
      expect(pickSprite(sprites, random)).toBe(chosen)
      choices.add(chosen!.id)
    }
    expect(choices.size).toBe(2)
  })
  test('标签优先完整单词，再按长度包含匹配', () => {
    expect(extractExpressionLabel('"JOY"', ['joy', 'sadness'])).toBe('joy')
    expect(extractExpressionLabel('I think it is sadness.', ['joy', 'sadness'])).toBe('sadness')
    expect(extractExpressionLabel('xxjoy_smilexx', ['joy', 'joy_smile'])).toBe('joy_smile')
    expect(extractExpressionLabel('sadness and joy', ['joy', 'sadness'])).toBe('joy')
    expect(extractExpressionLabel('乱码', ['joy', 'sadness'])).toBeNull()
    expect(extractExpressionLabel('joy', [])).toBeNull()
  })
})
