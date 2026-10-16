import { expect, test } from 'bun:test'
import { cx } from './ui'

test('同一类尺寸工具类只保留最后一个，其他类原样保留', () => {
  expect(cx('w-full h-9 px-3', 'w-24')).toBe('h-9 px-3 w-24')
  expect(cx('text-sm text-zinc-500', 'text-xs')).toBe('text-zinc-500 text-xs')
  // 不同变体前缀互不影响
  expect(cx('md:w-full w-full', 'w-10')).toBe('md:w-full w-10')
  // rounded-t-xl 是单独的方向圆角，不和整体圆角冲突
  expect(cx('rounded-lg', 'rounded-none', 'rounded-t-xl')).toBe('rounded-none rounded-t-xl')
  expect(cx('a', false, null, undefined, 'b')).toBe('a b')
})
