import { expect, test } from 'bun:test'
import { channelSettingsSchema, type MessageDTO } from '@nobot/shared'
import { channelSpeechPlan, splitVoiceText } from './voice-text'

const message = (content: string): MessageDTO => ({
  id: 'voice',
  chatId: 'chat',
  parentId: null,
  speakerId: null,
  role: 'assistant',
  content,
  meta: {},
  status: 'done',
  createdAt: 0,
  swipeIndex: 0,
  swipeCount: 1,
})

test('语音切分保留顺序，优先句末，超长句按 Unicode 字符切分', () => {
  expect(splitVoiceText('你好。世界！再见。', 6)).toEqual(['你好。世界！', '再见。'])
  expect(splitVoiceText('First. Second sentence. Last.', 15)).toEqual(['First.', 'Second sentence', '. Last.'])
  expect(splitVoiceText('😀😀😀😀😀', 2)).toEqual(['😀😀', '😀😀', '😀'])
  expect(splitVoiceText('   ', 1)).toEqual([])
})

test('语音计划分别绑定角色和旁白，排除协议、思考和选项', () => {
  const reply = message(
    '<think>SECRET</think><say who="Alice">Hello.</say><narration>She waves.</narration><say who="Bob">Hi.</say><choices>\n- Go\n</choices>',
  )
  const members = [
    { id: 'alice', name: 'Alice' },
    { id: 'bob', name: 'Bob' },
  ]
  for (const narration of ['speak', 'text', 'drop'] as const) {
    const plan = channelSpeechPlan(
      reply,
      members,
      channelSettingsSchema.parse({ voice: 'only', voiceNarration: narration }),
    )
    const dialogue = plan.segments.filter((segment) => segment.speaker.kind !== 'narrator')
    expect(dialogue.map((segment) => segment.speaker)).toEqual([
      { kind: 'character', characterId: 'alice' },
      { kind: 'character', characterId: 'bob' },
    ])
    expect(plan.segments.some((segment) => segment.speaker.kind === 'narrator')).toBe(narration === 'speak')
    expect(plan.narration).toBe(narration === 'text' ? 'She waves.' : '')
    expect(JSON.stringify(plan)).not.toMatch(/SECRET|Go|<say|<think/)
  }
})
