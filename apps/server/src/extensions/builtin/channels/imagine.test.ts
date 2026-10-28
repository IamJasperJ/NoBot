import { expect, test } from 'bun:test'
import { parseImagine } from './imagine'

test('频道生图参数：中英文模式、角色、方向和自由描述', () => {
  const cases: [string, Record<string, string>, string][] = [
    ['a beautiful landscape', { mode: 'free' }, 'a beautiful landscape'],
    ['场景 横 harbor at night', { mode: 'scene', orientation: 'landscape' }, 'harbor at night'],
    ['char Alice square blue dress', { mode: 'character', character: 'Alice', orientation: 'square' }, 'blue dress'],
    ['角色 Alice 竖', { mode: 'character', character: 'Alice', orientation: 'portrait' }, ''],
    ['Alice 方', { mode: 'character', character: 'Alice', orientation: 'square' }, ''],
    ['face "Alice Smith" portrait', { mode: 'face', character: 'Alice Smith', orientation: 'portrait' }, ''],
    ['free a cat', { mode: 'free' }, 'a cat'],
    ['portrait Alice landscape', { mode: 'portrait', character: 'Alice', orientation: 'landscape' }, ''],
  ]
  for (const [input, args, text] of cases) expect(parseImagine(input, ['Alice', 'Alice Smith'])).toEqual({ args, text })
  const modes = {
    character: ['character', 'char', '角色', '全身'],
    face: ['face', '脸', '头像', '特写'],
    portrait: ['portrait', '半身'],
    user: ['me', 'user', '我', '人设'],
    scene: ['scene', '场景'],
    last: ['last', '最后', '上一条'],
    raw_last: ['raw', 'raw_last', '原文'],
    background: ['background', 'bg', '背景'],
    free: ['free', '自由'],
  }
  for (const [mode, aliases] of Object.entries(modes))
    for (const alias of aliases) expect(parseImagine(alias, []).args.mode).toBe(mode)
  expect(parseImagine('SCENE 横', []).args).toEqual({ mode: 'scene', orientation: 'landscape' })
})
