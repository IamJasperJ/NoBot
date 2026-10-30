import { describe, expect, test } from 'bun:test'
import type { Beat } from '@nobot/shared'
import { thoughtVisibleCount } from './VnThought'
import { directivesOf, passedRange } from './vnEvents'

describe('VN 事件', () => {
  test('舞台指令：舞台操作原样给出，选项和 CG 各算一条，台词不算', () => {
    const beats: Beat[] = [
      {
        kind: 'stage',
        ops: [
          { op: 'show', who: 'A' },
          { op: 'hide', who: 'B' },
        ],
      },
      { kind: 'choices', options: [{ text: '是' }] },
      { kind: 'cg', prompt: 'sunset' },
      { kind: 'line', speaker: 'A', text: '你好' },
    ]
    expect(beats.flatMap(directivesOf)).toEqual([
      { op: 'show', who: 'A' },
      { op: 'hide', who: 'B' },
      { op: 'choices', options: [{ text: '是' }] },
      { op: 'cg', prompt: 'sunset' },
    ])
  })

  test('往前演补上中间的拍；回退和直接停在末拍只算当前拍；新消息从头演时从第 0 拍算', () => {
    expect(passedRange({ playKey: 'm#1', beatIndex: 1 }, 'm#1', 4, 1)).toEqual([2, 4])
    expect(passedRange({ playKey: 'm#1', beatIndex: 4 }, 'm#1', 2, 1)).toEqual([2, 2])
    expect(passedRange({ playKey: 'old#1', beatIndex: 3 }, 'm#1', 1, 1)).toEqual([0, 1])
    expect(passedRange(null, 'm#1', 6, 1)).toEqual([6, 6])
  })
})

describe('思考气泡', () => {
  test('演出时按进度分段浮现，至少一段；生成中或演完时全部显示', () => {
    expect(thoughtVisibleCount(3, 0, 5, false)).toBe(1)
    expect(thoughtVisibleCount(3, 2, 5, false)).toBe(2)
    expect(thoughtVisibleCount(3, 4, 5, false)).toBe(3)
    expect(thoughtVisibleCount(3, 0, 5, true)).toBe(3)
    expect(thoughtVisibleCount(3, 0, 0, false)).toBe(3)
  })
})
