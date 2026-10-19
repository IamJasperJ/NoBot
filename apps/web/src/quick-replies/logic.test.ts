import { expect, test } from 'bun:test'
import { type QuickReplySet, quickReplySchema, quickReplySetInput } from '@nobot/shared'
import { api } from '../api/client'
import { registerCommand } from '../commands/registry'
import type { CommandContext } from '../commands/run'
import { automationMatches, importQuickReplySet, mergeQuickReplySets, runQuickReply } from './logic'

const qr = quickReplySchema.parse({ id: 'button', label: 'hello', message: 'hello {{input}}' })
const set = (id: string): QuickReplySet => ({ ...quickReplySetInput.parse({ name: id, buttons: [qr] }), id })
test('作用域按全局、角色、会话顺序合并，忽略失效 id', () => {
  expect(
    mergeQuickReplySets([set('a'), set('b'), set('c')], ['b', 'deleted'], ['a', 'b'], ['c', 'a']).map((s) => s.id),
  ).toEqual(['b', 'a', 'c'])
})
test('所有自动执行条件、隐藏按钮、automationId 与深度上限', () => {
  const button = quickReplySchema.parse({
    ...qr,
    isHidden: true,
    automationId: 'scene',
    autoExecute: { onAi: true, onUser: true, onNewChat: true },
  })
  expect(automationMatches(button, 'onAi')).toBe(true)
  expect(automationMatches(button, 'onUser')).toBe(true)
  expect(automationMatches(button, 'onNewChat')).toBe(true)
  expect(automationMatches(button, 'onStartup')).toBe(false)
  expect(automationMatches(button, 'onChatChange')).toBe(false)
  expect(automationMatches(button, 'automationId', ['scene'])).toBe(true)
  expect(automationMatches(button, 'automationId', ['other'])).toBe(false)
  expect(automationMatches(button, 'onAi', [], 1)).toBe(false)
  expect(automationMatches(button, 'automationId', ['scene'], 1)).toBe(false)
  expect(automationMatches(qr, 'automationId', [''])).toBe(false)
})
test('发送、只填输入框、注入位置和宏不重复注入', async () => {
  const sent: string[] = []
  let input = 'draft'
  const ctx: CommandContext = {
    chatId: 'chat',
    api,
    generate: async (_id, value) => {
      if (value.mode === 'send') sent.push(value.text)
    },
    refresh: async () => {},
    getInput: () => input,
    setInput: (value) => {
      input = value
    },
    notify: () => {},
    prompt: async () => null,
    getActiveSets: async () => [],
  }
  await runQuickReply(qr, ctx, { ...set('a'), injectInput: true })
  expect(sent).toEqual(['hello draft'])
  await runQuickReply({ ...qr, message: 'suffix' }, ctx, { ...set('a'), injectInput: true })
  expect(sent[1]).toBe('draft suffix')
  await runQuickReply({ ...qr, message: 'prefix' }, ctx, { ...set('a'), injectInput: true, placeBeforeInput: true })
  expect(sent[2]).toBe('prefix draft')
  await runQuickReply(qr, ctx, { ...set('a'), disableSend: true })
  expect(input).toBe('hello draft')
  expect(sent.length).toBe(3)
  const dispose = registerCommand({
    name: 'test-qr-command',
    description: '',
    args: [],
    run: async (_ctx, _args, text) => text,
  })
  try {
    expect(await runQuickReply({ ...qr, message: '/test-qr-command {{input}}' }, ctx)).toBe('hello draft')
  } finally {
    dispose()
  }
})
test('酒馆 v2 集合导入和默认字段', () => {
  const imported = importQuickReplySet({
    name: 'ST',
    disableSend: true,
    qrList: [{ id: 1, label: 'button', message: '/echo hi', executeOnAi: true, automationId: 'scene' }],
  })
  expect(imported.buttons[0]?.id).toBe('1')
  expect(imported.buttons[0]?.autoExecute.onAi).toBe(true)
  expect(imported.buttons[0]?.autoExecute.onStartup).toBe(false)
  expect(imported.disableSend).toBe(true)
  expect(() => importQuickReplySet(null)).toThrow()
})

test('世界书元数据可缺省，多个回复中的 id 去重，只接受字符串', async () => {
  const { loreAutomationIds } = await import('./logic')
  expect(
    loreAutomationIds([
      { meta: undefined },
      { meta: {} },
      { meta: { lore: { automationIds: ['scene', 3, 'scene', 'place'] } } },
      { meta: { lore: { automationIds: 'wrong' } } },
    ]),
  ).toEqual(['scene', 'place'])
})
test('自动执行真实发送链路、双条件去重及生成深度阻断', async () => {
  const { runQuickReplyAutomation } = await import('./logic')
  const button = quickReplySchema.parse({ ...qr, isHidden: true, autoExecute: { onAi: true }, automationId: 'scene' })
  const sets = [{ ...set('auto'), buttons: [button] }]
  let sends = 0
  const ctx: CommandContext = {
    chatId: 'chat',
    api,
    generate: async () => {
      sends++
      // 模拟自动回复的生成完成事件，后代事件不得再次执行。
      await runQuickReplyAutomation(sets, 'onAi', ctx, ['scene'], 1)
    },
    refresh: async () => {},
    getInput: () => '',
    setInput: () => {},
    notify: () => {},
    prompt: async () => null,
    getActiveSets: async () => sets,
  }
  await runQuickReplyAutomation(sets, 'onAi', ctx, ['scene'])
  expect(sends).toBe(1)
  await runQuickReplyAutomation(sets, 'onUser', ctx, ['other'])
  expect(sends).toBe(1)
})
