import { expect, test } from 'bun:test'
import type { MessageDTO } from '@nobot/shared'
import { cleanProtocolText, visibleText } from './visible-text'

const message = (
  content: string,
  meta: MessageDTO['meta'] = {},
  role: MessageDTO['role'] = 'assistant',
): MessageDTO => ({
  id: 'visible',
  chatId: 'chat',
  parentId: null,
  speakerId: null,
  role,
  content,
  meta,
  status: 'done',
  createdAt: 0,
  swipeIndex: 0,
  swipeCount: 1,
})

test('平台正文隐藏工具协议、思考区块和半截内部标签，舞台文字与网页共用解析', () => {
  expect(visibleText(message('<think>private</think><say who="Alice">Hello</say><cg prompt="secret"/>'))).toBe(
    'Alice：Hello',
  )
  expect(cleanProtocolText('Hello<think>unfinished')).toBe('Hello')
  expect(visibleText(message('Hello<function_call>{"prompt":"secret"}</function_call>!'))).toBe('Hello!')
  expect(
    visibleText(
      message('{"prompt":"secret"}', {
        toolCalls: [{ id: 'call', name: 'generate_image', arguments: '{"prompt":"secret"}' }],
      }),
    ),
  ).toBe('')
  expect(visibleText(message('{"task_id":"secret"}', {}, 'tool'))).toBe('')
})

test('生图历史描述、提示词和元数据不回填成正文，正常台词仍然保留', () => {
  const meta: MessageDTO['meta'] = {
    imageGen: { mode: 'tool', status: 'pending', prompt: 'SECRET', caption: 'private caption' },
  }
  for (const role of ['assistant', 'system', 'tool'] as const) {
    for (const content of [
      'Alice sends a picture that contains: SECRET..',
      'SECRET',
      'private caption',
      '{"status":"queued","message":"SECRET"}',
    ])
      expect(visibleText(message(content, meta, role))).toBe('')
  }
  expect(visibleText(message('Hello\nAlice sends a picture that contains: SECRET..', meta))).toBe('Hello')
  expect(visibleText(message('Hello', meta))).toBe('Hello')
  expect(visibleText(message('SECRET', { ...meta, clientMessageId: 'imagine' }))).toBe('')
})
