import { expect, test } from 'bun:test'
import { DEFAULT_APPEARANCE, normalizeBackgroundColumns, useAppearance } from './appearance'

test('背景列数默认为 2，载入和写入使用相同的 2–6 整数边界', () => {
  expect(DEFAULT_APPEARANCE.backgroundColumns).toBe(2)
  for (const [value, expected] of [
    [1, 2],
    [9, 6],
    [3.7, 4],
    [Number.NaN, 2],
    ['bad', 2],
    [null, 2],
  ] as const) {
    expect(normalizeBackgroundColumns(value)).toBe(expected)
  }
  const old = useAppearance.getState().backgroundColumns
  try {
    useAppearance.getState().set({ backgroundColumns: 99 })
    expect(useAppearance.getState().backgroundColumns).toBe(6)
    useAppearance.getState().set({ backgroundColumns: 1 })
    expect(useAppearance.getState().backgroundColumns).toBe(2)
    useAppearance.getState().reset()
    expect(useAppearance.getState().backgroundColumns).toBe(2)
  } finally {
    useAppearance.getState().set({ backgroundColumns: old })
  }
})
