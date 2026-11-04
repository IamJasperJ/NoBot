import { expect, spyOn, test } from 'bun:test'
import type { ChannelBindingDTO, GenerateEvent, MessageDTO } from '@nobot/shared'
import * as chats from '../../../services/chats'
import * as generation from '../../../services/generation/generation'
import { ChannelService, suppressChannelRelay } from './service'
import * as store from './store'

type RelayMessage = Pick<MessageDTO, 'id' | 'role' | 'parentId' | 'meta'>
const row = (id: string, role: MessageDTO['role'], parentId: string | null, noRelay?: boolean): RelayMessage => ({
  id,
  role,
  parentId,
  meta: noRelay === undefined ? {} : { noRelay },
})

test('转发判断沿父链经过工具和多段回复，仅最近的用户决定来源', () => {
  const history = [
    row('dm', 'user', null, true),
    row('first', 'assistant', 'dm'),
    row('tool', 'tool', 'first'),
    row('second', 'assistant', 'tool'),
    row('normal', 'user', 'second'),
    row('reply', 'assistant', 'normal'),
    row('branch', 'assistant', 'dm'),
    row('false', 'assistant', 'dm', false),
  ]
  const lookup = (id: string) => history.find((message) => message.id === id)
  for (const id of ['dm', 'first', 'tool', 'second', 'branch', 'false'])
    expect(suppressChannelRelay(lookup(id)!, lookup)).toBe(true)
  for (const id of ['normal', 'reply']) expect(suppressChannelRelay(lookup(id)!, lookup)).toBe(false)
  expect(suppressChannelRelay(row('own', 'assistant', null, true), lookup)).toBe(true)
  expect(suppressChannelRelay(row('missing', 'assistant', 'gone'), lookup)).toBe(false)
  expect(suppressChannelRelay(row('root', 'assistant', null), lookup)).toBe(false)
  const cycle = row('cycle', 'assistant', 'cycle')
  expect(suppressChannelRelay(cycle, () => cycle)).toBe(false)
})

test('自身禁止转发时在排队前退出，文字和工具附件都不触碰渠道或合并队列', async () => {
  // 用空宿主验证提前退出：若进入任何投递路径就会因缺少运行时依赖失败。
  const deliver = ChannelService.prototype.deliver
  for (const meta of [{ noRelay: true }, { noRelay: true, images: [] }, { noRelay: true, stickers: [] }]) {
    let aborted = false
    await deliver.call(
      {} as ChannelService,
      {} as never,
      { meta } as MessageDTO,
      {
        abort: () => {
          aborted = true
        },
      } as never,
    )
    expect(aborted).toBe(true)
  }
})

test('生成事件从开始就不开流式，结束不投递、不进合并队列，完成仍释放订阅', () => {
  const binding = { id: 'binding', accountId: 'account', chatId: 'home', state: 'active' } as ChannelBindingDTO
  const bindings = spyOn(store, 'listBindings').mockReturnValue([binding])
  const bindingRow = spyOn(store, 'bindingRow').mockReturnValue(binding as never)
  const job = spyOn(generation, 'getJob').mockReturnValue({} as never)
  const parent = spyOn(chats, 'loadMessage').mockReturnValue(row('user', 'user', null, true) as MessageDTO)
  let listener: ((event: GenerateEvent) => void) | undefined
  let disposed = 0
  let delivered = 0
  const state = {
    runtime: { accounts: new Map([['account', { client: {} }]]) },
    host: {
      subscribe: (_job: unknown, callback: (event: GenerateEvent) => void) => {
        listener = callback
        return () => {
          disposed++
        }
      },
    },
    generationSubscriptions: new Map(),
    streams: new Map(),
    oneBotTurns: new Map(),
    deliver: () => {
      delivered++
    },
  }
  const service = Object.assign(Object.create(ChannelService.prototype), state) as {
    watchJobs(): void
  }
  try {
    service.watchJobs()
    const assistant = row('assistant', 'assistant', 'user') as MessageDTO
    listener!({ type: 'start', assistantMessage: assistant } as GenerateEvent)
    expect(state.streams.size).toBe(0)
    listener!({ type: 'delta', text: 'secret' } as GenerateEvent)
    listener!({ type: 'done', message: assistant } as GenerateEvent)
    expect(state.oneBotTurns.size).toBe(0)
    expect(delivered).toBe(0)
    listener!({ type: 'complete' } as GenerateEvent)
    expect(disposed).toBe(1)
    expect(state.generationSubscriptions.size).toBe(0)
  } finally {
    bindings.mockRestore()
    bindingRow.mockRestore()
    job.mockRestore()
    parent.mockRestore()
  }
})
