import { describe, expect, test } from 'bun:test'
import { type GroupMemberInfo, type SpeakerSelectionInput, selectSpeakers } from './group'

function member(id: string, overrides: Partial<GroupMemberInfo> = {}): GroupMemberInfo {
  return { id, name: id, muted: false, talkativeness: 0, ...overrides }
}

function select(overrides: Partial<SpeakerSelectionInput> = {}, sequence = [0]): string[] {
  let i = 0
  return selectSpeakers({
    members: [member('Alice'), member('Bob'), member('Carol', { muted: true })],
    activation: 'natural',
    allowSelfResponses: false,
    lastMessage: { role: 'user', speakerId: null, content: '' },
    spokenSinceUser: [],
    userTriggered: true,
    random: () => sequence[i++ % sequence.length]!,
    ...overrides,
  })
}

describe('selectSpeakers', () => {
  test('强制成员优先于模式与静音；未知成员不生效', () => {
    expect(select({ forcedSpeakerId: 'Bob', activation: 'list' })).toEqual(['Bob'])
    expect(select({ forcedSpeakerId: 'Carol', activation: 'manual' })).toEqual(['Carol'])
    expect(select({ members: [member('Carol', { muted: true })], forcedSpeakerId: 'Carol' })).toEqual(['Carol'])
    expect(select({ forcedSpeakerId: 'unknown', activation: 'list' })).toEqual(['Alice', 'Bob'])
  })

  test('manual：用户消息不选择，继续时从非静音成员随机选一个', () => {
    expect(select({ activation: 'manual' })).toEqual([])
    expect(select({ activation: 'manual', userTriggered: false }, [0.9])).toEqual(['Bob'])
  })

  test('list：按成员顺序返回并跳过静音，不排除上一位发言者', () => {
    expect(select({ activation: 'list', lastMessage: { role: 'assistant', speakerId: 'Alice', content: '' } })).toEqual(
      ['Alice', 'Bob'],
    )
  })

  test('pooled：只选未发言成员，全说过后重新随机选择', () => {
    expect(select({ activation: 'pooled', spokenSinceUser: ['Alice', 'unknown'] }, [0.9])).toEqual(['Bob'])
    expect(select({ activation: 'pooled', spokenSinceUser: ['Alice', 'Bob'] }, [0.9])).toEqual(['Bob'])
    expect(select({ activation: 'pooled', spokenSinceUser: ['Alice', 'Bob'] }, [0])).toEqual(['Alice'])
  })

  test('natural：点名忽略大小写、按首次位置排序、重复点名只返回一次', () => {
    expect(select({ lastMessage: { role: 'user', speakerId: null, content: 'Carol, bOB! Alice Bob Alice' } })).toEqual([
      'Bob',
      'Alice',
    ])
  })

  test('natural：名字拆词并取最早命中位置', () => {
    expect(
      select({
        members: [member('a', { name: 'Alice Smith' }), member('b', { name: 'Bob Jones' })],
        lastMessage: { role: 'user', speakerId: null, content: 'Jones Alice Bob Smith' },
      }),
    ).toEqual(['b', 'a'])
  })

  test('natural：英文全词、中文边界与正则特殊字符按字面匹配', () => {
    expect(
      select({
        members: [member('cat'), member('龙'), member('a+b'), member('nobody')],
        lastMessage: { role: 'user', speakerId: null, content: 'category 一条龙飞过 a+b' },
      }),
    ).toEqual(['龙', 'a+b'])
  })

  test('natural：禁止自己点名及积极度自选，允许自回复时恢复', () => {
    const input: Partial<SpeakerSelectionInput> = {
      members: [member('Alice', { talkativeness: 1 }), member('Bob', { talkativeness: 1 })],
      lastMessage: { role: 'assistant', speakerId: 'Alice', content: 'Alice Bob' },
    }
    expect(select(input)).toEqual(['Bob'])
    expect(select({ ...input, allowSelfResponses: true })).toEqual(['Alice', 'Bob'])
    expect(select({ ...input, lastMessage: { role: 'assistant', speakerId: 'Alice', content: 'Bob' } })).toEqual([
      'Bob',
    ])
    expect(
      select({
        ...input,
        allowSelfResponses: true,
        lastMessage: { role: 'assistant', speakerId: 'Alice', content: 'Bob' },
      }),
    ).toEqual(['Bob', 'Alice'])
  })

  test('natural：先洗牌，再逐个按严格小于积极度判断', () => {
    expect(
      select(
        {
          members: [
            member('A', { talkativeness: 0.5 }),
            member('B', { talkativeness: 0.5 }),
            member('C', { talkativeness: 1 }),
          ],
          lastMessage: null,
        },
        [0, 0.9, 0.1, 0.1, 0.5],
      ),
    ).toEqual(['C', 'B'])
  })

  test('natural：点名排在积极度选择之前，被点名者不再参与抽签', () => {
    let calls = 0
    expect(
      select({
        members: [member('Alice', { talkativeness: 1 }), member('Bob')],
        lastMessage: { role: 'user', speakerId: null, content: 'Bob' },
        random: () => {
          calls++
          return 0
        },
      }),
    ).toEqual(['Bob', 'Alice'])
    expect(calls).toBe(1)
  })

  test('natural：无人命中时随机兜底，允许再次选中上一位发言者', () => {
    expect(select({}, [0.1, 0.9, 0.9, 0.9])).toEqual(['Bob'])
    expect(
      select(
        {
          lastMessage: { role: 'assistant', speakerId: 'Alice', content: '' },
        },
        [0.9, 0],
      ),
    ).toEqual(['Alice'])
    expect(
      select({
        members: [member('Alice')],
        lastMessage: { role: 'assistant', speakerId: 'Alice', content: 'Alice' },
      }),
    ).toEqual(['Alice'])
  })

  test.each(['natural', 'manual', 'list', 'pooled'] as const)(
    '%s：空列表或全部静音返回空数组且不用随机数',
    (activation) => {
      const random = () => {
        throw new Error('没有候选时不应调用随机数')
      }
      expect(select({ members: [], activation, random })).toEqual([])
      expect(select({ members: [member('Alice', { muted: true })], activation, random })).toEqual([])
    },
  )
})
