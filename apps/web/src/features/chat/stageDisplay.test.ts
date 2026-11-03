import { describe, expect, test } from 'bun:test'
import type { MessageDTO } from '@nobot/shared'
import type { ChatCast } from './MessageItem'
import { stageDisplayFor } from './stageDisplay'

const rules = { knownNames: ['大肥鱼'], narratorNames: ['GM'], showSpeaker: true, choices: true }
const cast = (stage: ChatCast['stage']): ChatCast => ({
  speakers: {},
  fallback: { name: '角色', avatarUrl: null },
  user: { name: '我', avatarUrl: null },
  stage,
  pastStage: { ...rules, choices: false },
})
const staged = {
  role: 'assistant',
  meta: {
    stage: {
      ops: [],
      beats: [{ kind: 'line', speaker: '路人甲', text: '你好' }],
    },
  },
} as unknown as Pick<MessageDTO, 'role' | 'meta'>
const plain = { role: 'assistant', meta: {} } as Pick<MessageDTO, 'role' | 'meta'>

describe('stageDisplayFor', () => {
  test('开着舞台指令时所有角色回复都按当前规则', () => {
    expect(stageDisplayFor(cast(rules), plain)).toBe(rules)
    expect(stageDisplayFor(cast(rules), staged)).toBe(rules)
  })

  test('关掉指令后，开着指令时生成的回复仍按舞台显示，补上它自己的说话人、不显示选项', () => {
    const result = stageDisplayFor(cast(null), staged)
    expect(result?.knownNames).toEqual(['大肥鱼', '路人甲'])
    expect(result?.narratorNames).toEqual(['GM'])
    expect(result?.choices).toBe(false)
  })

  test('关掉指令后，没有舞台解析结果的回复和用户消息原样显示', () => {
    expect(stageDisplayFor(cast(null), plain)).toBeNull()
    expect(stageDisplayFor(cast(rules), { ...staged, role: 'user' })).toBeNull()
  })
})
