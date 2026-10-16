import { expect, test } from 'bun:test'
import { matchBackground } from './background-match'

const list = [{ name: '森林' }, { name: '月光森林' }, { name: '海边' }, { name: 'Castle' }]

test('背景选择优先精确匹配，再包含和编辑距离，空回复不设置背景', () => {
  expect(matchBackground(list, '森林')).toBe(list[0])
  expect(matchBackground(list, '我选择月光森林。')).toBe(list[1])
  expect(matchBackground(list, '月光')).toBe(list[1])
  expect(matchBackground(list, '海滨')).toBe(list[2])
  expect(matchBackground(list, '  CASTLE  ')).toBe(list[3])
  expect(matchBackground(list, '')).toBeUndefined()
  expect(matchBackground(list, '  ')).toBeUndefined()
  expect(matchBackground([], '森林')).toBeUndefined()
  expect(matchBackground([{ name: '甲乙' }, { name: '甲丙' }], '甲丁')?.name).toBe('甲乙')
})
