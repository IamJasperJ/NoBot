import { expect, spyOn, test } from 'bun:test'
import { type ChannelBindingDTO, channelSettingsSchema, type MessageDTO } from '@nobot/shared'
import * as database from '../../../db/client'
import type { ExtensionHost } from '../../types'
import { ChannelSendError } from '../../types'
import * as assets from './adapters/telegram/media'
import type { ChannelClient } from './adapters/types'
import { OutboundMedia } from './outbound-media'
import * as providers from './providers'
import * as store from './store'
import type { VoiceDeliverySettings } from './voice-decision'

function setup(kind: 'unknown' | 'not-sent') {
  const saved = new Map<string, unknown>()
  const get = spyOn(database, 'getSetting').mockImplementation(<T>(key: string) => saved.get(key) as T | undefined)
  const set = spyOn(database, 'setSetting').mockImplementation((key, value) => {
    saved.set(key, structuredClone(value))
  })
  const asset = spyOn(assets, 'readMediaAsset').mockResolvedValue({
    bytes: new Uint8Array([1]),
    mime: 'image/png',
    filename: 'image.png',
  })
  const account = spyOn(store, 'accountRow').mockReturnValue({ provider: 'test.plugin' } as never)
  const provider = spyOn(providers, 'getProvider').mockReturnValue({
    capabilities: { sceneImages: 'unsupported' },
  } as never)
  let calls = 0
  const client = {
    serialized: async (_chat: string, work: () => Promise<unknown>) => work(),
    call: async () => {
      calls++
      throw new ChannelSendError(kind, 'test')
    },
  } as unknown as ChannelClient
  const binding = { id: 'binding', chat: 'peer', thread: '', accountId: 'account', chatId: 'home' } as ChannelBindingDTO
  const message = {
    id: 'message',
    role: 'assistant',
    content: '',
    meta: { images: [{ id: 'image', url: '/api/assets/attachments/image.png' }] },
  } as MessageDTO
  const media = new OutboundMedia({} as ExtensionHost, () => {})
  return {
    run: () => media.deliver(binding, message, { generatedImages: 'send' } as VoiceDeliverySettings, client, 'account'),
    calls: () => calls,
    close: () => {
      for (const spy of [get, set, asset, account, provider]) spy.mockRestore()
      media.dispose()
    },
  }
}

test('不确定图片结果持久化为已处理，元数据重放不重发；明确未发送允许下轮处理', async () => {
  for (const kind of ['unknown', 'not-sent'] as const) {
    const f = setup(kind)
    try {
      await f.run()
      await f.run()
      expect(f.calls()).toBe(kind === 'unknown' ? 1 : 2)
    } finally {
      f.close()
    }
  }
})

test('场景能力明确关闭或跟随图片关闭时跳过状态卡，显式开启可覆盖', async () => {
  const stage = await import('../../../services/generation/stage')
  const members = spyOn(stage, 'stageMembers').mockReturnValue([])
  const account = spyOn(store, 'accountRow').mockReturnValue({ provider: 'test.plugin' } as never)
  const get = spyOn(database, 'getSetting').mockReturnValue(undefined)
  const set = spyOn(database, 'setSetting').mockImplementation(() => {})
  const provider = spyOn(providers, 'getProvider')
  const binding = { id: 'binding', chat: 'peer', thread: '', accountId: 'account', chatId: 'home' } as ChannelBindingDTO
  const message = {
    id: 'scene',
    role: 'assistant',
    content: 'hello',
    meta: { varsPatch: { health: 10 } },
    chatId: 'home',
    parentId: null,
    status: 'done',
    speakerId: null,
    speakerName: null,
    createdAt: 1,
    updatedAt: 1,
    swipeIndex: 0,
    swipeCount: 1,
  } as MessageDTO
  const media = new OutboundMedia({} as ExtensionHost, () => {})
  try {
    for (const [capabilities, expected] of [
      [{ sceneImages: 'unsupported', outboundImages: 'supported' }, 0],
      [{ outboundImages: 'unsupported' }, 0],
      [{ outboundImages: 'supported' }, 1],
      [{ sceneImages: 'supported', outboundImages: 'unsupported' }, 1],
    ] as const) {
      provider.mockReturnValue({ capabilities } as never)
      let calls = 0
      const client = {
        serialized: async (_chat: string, work: () => Promise<unknown>) => work(),
        call: async () => {
          calls++
          return { message_id: 'status' }
        },
      } as unknown as ChannelClient
      await media.deliver(
        binding,
        message,
        channelSettingsSchema.parse({ sprites: 'off', statusCard: 'every' }),
        client,
        'account',
      )
      expect(calls).toBe(expected)
    }
  } finally {
    for (const spy of [members, account, get, set, provider]) spy.mockRestore()
    media.dispose()
  }
})
