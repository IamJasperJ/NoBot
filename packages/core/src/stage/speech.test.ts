import { expect, test } from 'bun:test'
import { speechSegments } from './speech'

const members = [{ id: 'alice', name: 'Alice' }]
const message = { role: 'assistant' as const, content: '', meta: {}, speakerId: 'alice' }

test('普通引语与旁白沿用服务端分段，流式末段不提前朗读', () => {
  const input = { ...message, content: '她笑了。「你好。」她走向门口' }
  expect(speechSegments(input, members).map((s) => [s.speaker.kind, s.text])).toEqual([
    ['narrator', '她笑了。'],
    ['character', '你好。'],
    ['narrator', '她走向门口'],
  ])
  expect(speechSegments(input, members, true)).toEqual(speechSegments(input, members).slice(0, -1))
  expect(speechSegments({ ...message, content: '「没写完' }, members, true)).toEqual([])
})

test('舞台台词保留表情和原始拍序号，末拍旁白里的完整分段无需等下一拍', () => {
  const input = { ...message, content: 'Alice[joy]: Hello\n旁白「一句」未完' }
  const complete = speechSegments(input, members)
  expect(complete[0]).toMatchObject({
    speaker: { kind: 'npc', name: 'Alice' },
    text: 'Hello',
    expression: 'joy',
    beatIndex: 0,
  })
  expect(speechSegments(input, members, true)).toEqual(complete.slice(0, -1))
})

test('四种开引号确认旁白结束，闭引号后开始下一段才提交引语', () => {
  for (const [open, close] of [
    ['「', '」'],
    ['『', '』'],
    ['“', '”'],
    ['"', '"'],
  ]) {
    const prefix = `雨落下来。${open}`
    expect(speechSegments({ ...message, content: prefix }, members, true).map((s) => s.text)).toEqual(['雨落下来。'])
    expect(speechSegments({ ...message, content: `${prefix}你好${close}` }, members, true).map((s) => s.text)).toEqual([
      '雨落下来。',
    ])
    expect(
      speechSegments({ ...message, content: `${prefix}你好${close}。` }, members, true).map((s) => s.text),
    ).toEqual(['雨落下来。', '你好'])
  }
})

test('单成员、群聊发言者和 NPC 引语归属，用户消息保持原文', () => {
  expect(speechSegments({ ...message, speakerId: null, content: '「Hello」' }, members)[0]?.speaker).toEqual({
    kind: 'character',
    characterId: 'alice',
  })
  expect(
    speechSegments({ ...message, speakerId: null, meta: { name: 'Bob' }, content: '「Hello」' }, [])[0]?.speaker,
  ).toEqual({ kind: 'npc', name: 'Bob' })
  expect(speechSegments({ ...message, role: 'user', content: '「Hello」' }, members)).toEqual([
    { speaker: { kind: 'user' }, text: '「Hello」', beatIndex: 0 },
  ])
})
