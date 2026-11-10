import { expect, test } from 'bun:test'
import { channelAccountInput } from '@nobot/shared'
import { type ChannelProviderDefinition, ChannelSendError } from '../../../types'
import { PluginChannelClient } from './plugin'

function setup(image = true) {
  const events: string[] = []
  const received: { chatId: string; bytes: Uint8Array; mime: string; replyTo?: string }[] = []
  const definition: ChannelProviderDefinition = {
    id: 'test',
    name: 'test',
    scopes: ['private'],
    canInitiate: false,
    limits: { maxTextLength: 500 },
    media: { inboundImages: true, outboundImages: true, voice: false },
    accountFields: [],
    start() {},
    send: async (_account, message) => {
      events.push(message.text)
      return { id: 'text' }
    },
  }
  if (image)
    definition.sendImage = async (_account, message) => {
      received.push(message)
      events.push('image')
      return { id: String(received.length) }
    }
  const client = new PluginChannelClient(
    definition,
    { id: 'account', config: {}, cursor: null },
    channelAccountInput.parse({ name: 'test', provider: 'test.plugin' }),
    new AbortController().signal,
  )
  client.sleep = async () => {}
  client.status('online')
  const photo = () => {
    const form = new FormData()
    form.set('chat_id', 'peer')
    form.set('photo', new Blob([new Uint8Array([1, 2])], { type: 'image/png' }), 'test.png')
    form.set('caption', 'caption')
    form.set('reply_to_message_id', 'reply')
    return form
  }
  const album = () => {
    const form = photo()
    form.set(
      'media',
      JSON.stringify(
        [0, 1, 2].map((i) => {
          form.set(`photo${i}`, new Blob([String(i)], { type: 'image/png' }))
          return { type: 'photo', media: `attach://photo${i}` }
        }),
      ),
    )
    return form
  }
  return { definition, client, events, received, photo, album }
}

test('Blob 传给 sendImage，图片后发送 caption，回执不含可缓存 file_id', async () => {
  const f = setup()
  expect(await f.client.call<{ message_id: string }>('sendPhoto', f.photo())).toEqual({ message_id: '1' })
  expect(f.received[0]).toEqual({ chatId: 'peer', bytes: new Uint8Array([1, 2]), mime: 'image/png', replyTo: 'reply' })
  expect(f.events).toEqual(['image', 'caption'])
})

test('无 sendImage 或关闭出站图片保持旧行为', async () => {
  for (const enabled of [true, false]) {
    const f = setup(!enabled)
    f.definition.media.outboundImages = enabled
    expect(await f.client.call('sendPhoto', f.photo())).toBe(true)
    expect(await f.client.call('sendMediaGroup', f.album())).toBe(true)
    expect(f.events).toEqual([])
  }
})

test('相册逐张发送，与文字共用账号串行队列', async () => {
  const f = setup()
  const [album] = await Promise.all([
    f.client.call<{ message_id: string }[]>('sendMediaGroup', f.album()),
    f.client.call('sendMessage', { chat_id: 'other', text: 'after' }),
  ])
  expect(album).toEqual([{ message_id: '1' }, { message_id: '2' }, { message_id: '3' }])
  expect(f.events).toEqual(['image', 'image', 'image', 'after'])
})

test('相册中途失败立即停止，已发送部分升级为不确定；后续队列仍可用', async () => {
  const f = setup()
  let calls = 0
  f.definition.sendImage = async () => {
    if (++calls === 2) throw new ChannelSendError('not-sent', 'offline')
    return { id: 'first' }
  }
  await expect(f.client.call('sendMediaGroup', f.album())).rejects.toMatchObject({ kind: 'unknown' })
  expect(calls).toBe(2)
  await f.client.call('sendMessage', { chat_id: 'peer', text: 'after' })
  expect(f.events).toEqual(['after'])
})

test('仅 not-sent 且有有效退避才重试，未知结果不重试', async () => {
  for (const kind of ['not-sent', 'unknown'] as const) {
    const f = setup()
    let calls = 0
    f.definition.sendImage = async () => {
      if (++calls === 1) throw new ChannelSendError(kind, 'test', { retryAfterMs: 1 })
      return { id: 'ok' }
    }
    if (kind === 'not-sent') await f.client.call('sendPhoto', f.photo())
    else await expect(f.client.call('sendPhoto', f.photo())).rejects.toMatchObject({ kind })
    expect(calls).toBe(kind === 'not-sent' ? 2 : 1)
  }
})
