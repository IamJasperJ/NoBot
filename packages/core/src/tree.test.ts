import { describe, expect, test } from 'bun:test'
import { buildChildrenMap, collectSubtree, findLatestLeaf, siblingOf, swipeInfo } from './tree'

/**
 * 和设计文档里的图一样的树：
 *   a0 开场白
 *   └ u1 你好
 *      ├ a1 回复 v1 ─ u2b ─ a2b
 *      ├ a1b 回复 v2 ─ u2 ─ a2
 *      └ a1c 回复 v3
 * id 的字母顺序就是创建顺序
 */
const nodes = [
  { id: '01', parentId: null }, // a0
  { id: '02', parentId: '01' }, // u1
  { id: '03', parentId: '02' }, // a1
  { id: '04', parentId: '03' }, // u2b
  { id: '05', parentId: '04' }, // a2b
  { id: '06', parentId: '02' }, // a1b
  { id: '07', parentId: '06' }, // u2
  { id: '08', parentId: '07' }, // a2
  { id: '09', parentId: '02' }, // a1c
]
const children = buildChildrenMap(nodes)
const byId = (id: string) => nodes.find((n) => n.id === id) as (typeof nodes)[number]

describe('消息树', () => {
  test('swipe 序号按创建顺序', () => {
    expect(swipeInfo(children, byId('03'))).toEqual({ swipeIndex: 1, swipeCount: 3 })
    expect(swipeInfo(children, byId('06'))).toEqual({ swipeIndex: 2, swipeCount: 3 })
    expect(swipeInfo(children, byId('01'))).toEqual({ swipeIndex: 1, swipeCount: 1 })
  })

  test('切到兄弟节点后，沿最新子节点走到叶子', () => {
    expect(findLatestLeaf(children, '03')).toBe('05')
    expect(findLatestLeaf(children, '06')).toBe('08')
    expect(findLatestLeaf(children, '09')).toBe('09')
  })

  test('左右兄弟', () => {
    expect(siblingOf(children, byId('06'), -1)?.id).toBe('03')
    expect(siblingOf(children, byId('06'), 1)?.id).toBe('09')
    expect(siblingOf(children, byId('09'), 1)).toBeNull()
  })

  test('收集子树', () => {
    expect(collectSubtree(children, '03').sort()).toEqual(['03', '04', '05'])
    expect(collectSubtree(children, '02')).toHaveLength(8)
  })
})
