import { Database } from 'bun:sqlite'
import { expect, spyOn, test } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  type ChannelBindingDTO,
  channelAccountInput,
  channelSettingsSchema,
  type GenerateEvent,
  type MessageDTO,
} from '@nobot/shared'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import * as chats from '../../../services/chats'
import * as generation from '../../../services/generation/generation'
import * as stage from '../../../services/generation/stage'
import * as userContext from '../../../user-context'
import type { ChannelProviderDefinition, ExtensionHost } from '../../types'
import { PluginChannelClient } from './adapters/plugin'
import * as assets from './adapters/telegram/media'
import { ChannelDelivery } from './delivery'
import { OutboundMedia } from './outbound-media'
import * as providers from './providers'
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
  // 投递逻辑已拆到 ChannelDelivery，提前退出发生在那里。
  const deliver = ChannelDelivery.prototype.deliver
  for (const meta of [{ noRelay: true }, { noRelay: true, images: [] }, { noRelay: true, stickers: [] }]) {
    let aborted = false
    await deliver.call(
      {} as ChannelDelivery,
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

function pluginDelivery() {
  const texts: string[] = []
  const images: { chatId: string; bytes: Uint8Array; mime: string; replyTo?: string }[] = []
  const events: string[] = []
  const logs: string[] = []
  const definition: ChannelProviderDefinition = {
    id: 'test.plugin',
    name: 'test',
    scopes: ['private'],
    canInitiate: true,
    limits: { maxTextLength: 500 },
    media: { inboundImages: false, outboundImages: true, voice: false },
    accountFields: [],
    start() {},
    send: async (_account, message) => {
      texts.push(message.text)
      events.push('text')
      return { id: `text-${texts.length}` }
    },
    sendImage: async (_account, message) => {
      images.push(message)
      events.push('image')
      return { id: `image-${images.length}` }
    },
  }
  const client = new PluginChannelClient(
    definition,
    { id: 'account', config: {}, cursor: null },
    channelAccountInput.parse({ name: 'test', provider: 'test.plugin' }),
    new AbortController().signal,
  )
  client.sleep = async () => {}
  client.status('online')
  const binding = {
    id: 'binding',
    accountId: 'account',
    chatId: 'home',
    chat: 'peer',
    thread: '',
    state: 'active',
  } as ChannelBindingDTO
  const message = {
    id: 'image-message',
    chatId: 'home',
    role: 'tool',
    content: '',
    parentId: null,
    status: 'done',
    meta: {
      imageGen: { status: 'done', mode: 'text', prompt: 'A landscape' },
      images: [{ id: 'image', url: '/api/assets/attachments/image.png' }],
    },
  } as MessageDTO
  // 独立内存库保留真实回执和媒体去重读写，避免无关迁移与账号配置干扰回归。
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE channel_deliveries (
      id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, message_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, parts TEXT NOT NULL,
      status TEXT NOT NULL, content_hash TEXT NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  const context = spyOn(userContext, 'currentContext').mockReturnValue({ db: drizzle(sqlite) } as never)
  const bindingSpy = spyOn(store, 'bindingRow').mockReturnValue(binding)
  const account = spyOn(store, 'accountRow').mockReturnValue({ provider: 'test.plugin' } as never)
  const members = spyOn(stage, 'stageMembers').mockReturnValue([])
  const provider = spyOn(providers, 'getProvider').mockReturnValue({
    capabilities: { sceneImages: 'unsupported' },
  } as never)
  const asset = spyOn(assets, 'readMediaAsset').mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    mime: 'image/png',
    filename: 'image.png',
  })
  const synthesizeSpeech = spyOn(
    {
      run: async () => {
        throw new Error('不应合成语音')
      },
    },
    'run',
  )
  const media = new OutboundMedia({ synthesizeSpeech } as unknown as ExtensionHost, (_id, code) => logs.push(code))
  // 仅略过路由和正文变更守卫；保留 deliver 排队、扩展平台文字投递和完整媒体路径。
  const service = Object.assign(Object.create(ChannelService.prototype), {
    runtime: { accounts: new Map([['account', { client }]]), log: (_id: string, code: string) => logs.push(code) },
    media,
    routesTo: () => true,
    burstGuard: () => () => true,
    settings: () => ({ values: channelSettingsSchema.parse({ generatedImages: 'send', cg: 'send', voice: 'auto' }) }),
    oneBotTurns: new Map(),
    deliveryTails: new Map(),
    inboundScope: new AsyncLocalStorage(),
  }) as ChannelService
  return {
    definition,
    client,
    binding,
    message,
    media,
    texts,
    images,
    events,
    logs,
    synthesizeSpeech,
    deliver: (value = message) => service.deliver(binding, value),
    close: () => {
      media.dispose()
      for (const spy of [context, bindingSpy, account, members, provider, asset]) spy.mockRestore()
      sqlite.close()
    },
  }
}

test('扩展平台从 service 投递无正文工具图片，字节和位置正确，重复更新不重发', async () => {
  const f = pluginDelivery()
  try {
    await f.deliver()
    await f.deliver()
    expect(f.images).toEqual([
      { chatId: 'peer', bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', replyTo: undefined },
    ])
    expect(f.texts).toEqual([])
    expect(f.synthesizeSpeech).not.toHaveBeenCalled()
  } finally {
    f.close()
  }
})

test('扩展平台已投递的 assistant 正文不重发，后补 CG 仍投递且在文字之后', async () => {
  const f = pluginDelivery()
  try {
    const message: MessageDTO = { ...f.message, role: 'assistant', content: 'hello', meta: {} }
    await f.deliver(message)
    expect(f.events).toEqual(['text'])
    expect(f.synthesizeSpeech).not.toHaveBeenCalled()
    message.meta = { images: [{ ...f.message.meta.images![0]!, isCg: true }] }
    await f.deliver(message)
    await f.deliver(message)
    expect(f.texts).toEqual(['hello'])
    expect(f.images).toHaveLength(1)
    expect(f.events).toEqual(['text', 'image'])
  } finally {
    f.close()
  }
})

test('扩展平台关闭出站图片或缺少 sendImage 时不投递图片，也不发失败提示', async () => {
  for (const disabled of ['capability', 'method'] as const) {
    const f = pluginDelivery()
    const deliverMedia = spyOn(f.media, 'deliver')
    try {
      if (disabled === 'capability') f.definition.media.outboundImages = false
      else delete f.definition.sendImage
      await f.deliver()
      await f.deliver({ ...f.message, meta: { imageGen: { status: 'error', mode: 'text', prompt: 'A landscape' } } })
      expect(f.images).toEqual([])
      expect(f.texts).toEqual([])
      expect(deliverMedia).not.toHaveBeenCalled()
    } finally {
      deliverMedia.mockRestore()
      f.close()
    }
  }
})

test('扩展平台待完成的生图不发动作或占位文字，也不启动占位定时器', async () => {
  const f = pluginDelivery()
  const call = spyOn(f.client, 'call')
  const interval = spyOn(globalThis, 'setInterval')
  try {
    await f.deliver({
      ...f.message,
      meta: { clientMessageId: 'imagine', imageGen: { status: 'pending', mode: 'text', prompt: 'A landscape' } },
    })
    expect(f.images).toEqual([])
    expect(f.texts).toEqual([])
    expect(call).not.toHaveBeenCalled()
    expect(interval).not.toHaveBeenCalled()
  } finally {
    call.mockRestore()
    interval.mockRestore()
    f.close()
  }
})

test('扩展平台媒体异常只记录 media.failed，不向投递调用者抛出', async () => {
  const f = pluginDelivery()
  const media = spyOn(f.media, 'deliver').mockRejectedValue(new Error('test'))
  try {
    await f.deliver()
    expect(f.logs).toEqual(['media.failed'])
  } finally {
    media.mockRestore()
    f.close()
  }
})
