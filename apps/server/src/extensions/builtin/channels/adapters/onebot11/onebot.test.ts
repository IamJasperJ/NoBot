import { expect, test } from 'bun:test'
import { channelAccountInput } from '@nobot/shared'
import { implementationCapabilities } from '../../capabilities'
import { OneBotClient, splitOneBot } from './client'
import { decodeOneBot, oneBotSegments } from './receive'
import { type OneBotDialSocket, OneBotError, OneBotSendQueue, OneBotTransport } from './transport'

function setup() {
  const calls: { action: string; params: Record<string, unknown>; echo: string }[] = []
  let paused = 0
  const statuses: string[] = []
  const transport = new OneBotTransport({
    token: 'SECRET',
    timeoutMs: 20,
    onConnect: async () => {},
    onEvent: () => {},
    onStatus: (status) => statuses.push(status),
    onBreaker: () => paused++,
  })
  transport.attach({ send: (raw) => calls.push(JSON.parse(raw)), close: () => {} })
  const config = channelAccountInput.parse({
    provider: 'onebot11',
    name: 'QQ',
    credentials: { accessToken: 'SECRET' },
    connection: { mode: 'ws-reverse' },
  })
  const queue = new OneBotSendQueue(
    config.rateLimit,
    Date.now,
    async () => {},
    () => 0,
  )
  const client = new OneBotClient(
    transport,
    config,
    async () => new Response(new Uint8Array([1, 2, 3])),
    undefined,
    queue,
  )
  client.selfId = '999'
  client.implementation = { name: 'NapCat', version: 'test' }
  const respond = (index: number, data: unknown, retcode = 0, wording = '') =>
    transport.receive({ echo: calls[index]!.echo, status: retcode ? 'failed' : 'ok', retcode, data, wording })
  return { calls, client, transport, respond, statuses, paused: () => paused }
}

test('OneBot echo 隔离、超时、心跳、熔断不泄漏平台错误', async () => {
  const s = setup()
  const first = s.transport.call('first')
  const second = s.transport.call('second')
  s.respond(1, 'second')
  s.respond(0, 'first')
  expect(await first).toBe('first')
  expect(await second).toBe('second')
  await expect(s.transport.call('timeout')).rejects.toBeInstanceOf(OneBotError)
  s.transport.receive({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true } })
  expect(s.transport.lastHeartbeatAt).not.toBeNull()
  const risk = s.transport.call('send_group_msg')
  s.respond(3, null, 1200, 'risk control SECRET')
  await expect(risk).rejects.toThrow('渠道请求失败')
  expect(s.paused()).toBe(1)
  expect(s.transport.paused).toBe(true)
  await expect(s.transport.call('blocked')).rejects.toThrow()
})

test('连续三次 retcode 失败熔断，停止取消 pending', async () => {
  const s = setup()
  for (let i = 0; i < 3; i++) {
    const action = s.transport.call('failure')
    s.respond(i, null, 100)
    await expect(action).rejects.toThrow()
  }
  expect(s.paused()).toBe(1)
  const other = setup()
  const pending = other.transport.call('wait')
  other.transport.stop()
  await expect(pending).rejects.toThrow()
})

test('正向连接传递 token，关闭后退避重连，中止退出', async () => {
  const controller = new AbortController()
  const endpoints: string[] = []
  const delays: number[] = []
  let connections = 0
  const transport = new OneBotTransport({
    token: 'SECRET',
    onConnect: async () => {},
    onEvent: () => {},
    onStatus: () => {},
    onBreaker: () => {},
    sleep: async (ms) => {
      delays.push(ms)
    },
    dial: (url, token) => {
      endpoints.push(`${url}:${token}`)
      const handlers = new Map<string, (event: { data?: unknown }) => void>()
      const socket: OneBotDialSocket = {
        send: () => {},
        close: () => handlers.get('close')?.({}),
        addEventListener: (type, callback) => {
          handlers.set(type, callback)
        },
      }
      setTimeout(() => {
        connections++
        handlers.get('open')?.({})
        if (connections === 2) controller.abort()
        else handlers.get('close')?.({})
      }, 0)
      return socket
    },
  })
  await transport.forward('ws://fake', controller.signal)
  expect(endpoints).toEqual(['ws://fake:SECRET', 'ws://fake:SECRET'])
  expect(delays).toEqual([500])
})

test('账号全局分钟预算与同聊天间隔不会被并行发送绕过', async () => {
  let now = 0
  const waits: number[] = []
  const queue = new OneBotSendQueue(
    { perMinute: 2, minIntervalMs: 1200 },
    () => now,
    async (ms) => {
      waits.push(ms)
      now += ms
    },
    () => 0,
  )
  await Promise.all([queue.send('a', async () => {}), queue.send('a', async () => {}), queue.send('b', async () => {})])
  expect(waits).toEqual([0, 1200, 58800])
})

test('数组和 CQ 文本解码 @、引用、表情、图片、语音；忽略自身与 message_sent', () => {
  const { client } = setup()
  const raw = {
    post_type: 'message',
    message_type: 'group',
    group_id: 100,
    user_id: 123,
    self_id: 999,
    message_id: 55,
    sender: { nickname: 'Player' },
    message:
      'hello &amp; [CQ:at,qq=999][CQ:reply,id=11][CQ:face,id=14][CQ:image,file=a,url=https://fake/a][CQ:record,file=b]',
  }
  const event = decodeOneBot(raw, client)
  expect(event).toMatchObject({
    text: 'hello & [表情: 微笑]',
    displayName: 'Player',
    mentionsBot: true,
    chat: { id: -100 },
    reply_to_message: { message_id: 11 },
    voice: { mime_type: 'audio/mpeg' },
  })
  expect(decodeOneBot({ ...raw, sender: { card: 'Card', nickname: 'Player' } }, client)?.displayName).toBe('Card')
  expect(decodeOneBot({ ...raw, sender: { card: '', nickname: 'Player' } }, client)?.displayName).toBe('Player')
  expect(decodeOneBot({ ...raw, message_type: 'private', group_id: undefined }, client)?.chat).toMatchObject({
    id: 123,
    type: 'private',
  })
  expect(event?.photo?.length).toBe(1)
  expect(decodeOneBot({ ...raw, message: oneBotSegments(raw.message) }, client)).toEqual(event)
  expect(decodeOneBot({ ...raw, user_id: 999 }, client)).toBeNull()
  expect(decodeOneBot({ ...raw, post_type: 'message_sent' }, client)).toBeNull()
  expect(decodeOneBot({ ...raw, message: '[CQ:at,qq=999] /roll 1d6 blind' }, client)?.command).toEqual({
    name: 'roll',
    args: '1d6 blind',
  })
})

test('分段保留段落和 emoji；发送群引用、图片、语音与安全退群参数', async () => {
  expect(splitOneBot(`${'a'.repeat(70)}\n\n${'😀'.repeat(80)}`, 100)).toEqual([
    `${'a'.repeat(70)}\n\n`,
    '😀'.repeat(80),
  ])
  const s = setup()
  const send = s.client.call('sendMessage', {
    chat_id: '-100',
    text: '<b>Hello</b>',
    parse_mode: 'HTML',
    reply_parameters: { message_id: 10 },
  })
  await Bun.sleep(0)
  expect(s.calls[0]).toMatchObject({
    action: 'send_group_msg',
    params: {
      group_id: 100,
      message: [
        { type: 'reply', data: { id: '10' } },
        { type: 'text', data: { text: 'Hello' } },
      ],
    },
  })
  s.respond(0, { message_id: 20 })
  await send
  for (const [method, field, type] of [
    ['sendPhoto', 'photo', 'image'],
    ['sendVoice', 'voice', 'record'],
  ]) {
    const form = new FormData()
    form.set('chat_id', '123')
    form.set(field!, new Blob(['test']))
    const action = s.client.call(method!, form)
    await Bun.sleep(0)
    const index = s.calls.length - 1
    expect(s.calls[index]).toMatchObject({
      action: 'send_private_msg',
      params: { user_id: 123, message: [{ type, data: { file: 'base64://dGVzdA==' } }] },
    })
    s.respond(index, { message_id: 21 })
    await action
  }
  const leave = s.client.call('leaveChat', { chat_id: '-100' })
  expect(s.calls.at(-1)).toMatchObject({ action: 'set_group_leave', params: { group_id: 100, is_dismiss: false } })
  s.respond(s.calls.length - 1, true)
  await leave
})

test('远端语音 get_record mp3/base64，不能读取远端绝对路径', async () => {
  const s = setup()
  const key = s.client.registerMedia('record', 'voice')
  const pending = s.client.downloadFile(key, 100)
  expect(s.calls[0]).toMatchObject({ action: 'get_record', params: { file: 'voice', out_format: 'mp3' } })
  s.respond(0, { base64: 'dGVzdA==' })
  expect(Buffer.from(await pending).toString()).toBe('test')
  const bad = s.client.downloadFile(key, 100)
  s.respond(1, { file: '/etc/passwd' })
  await expect(bad).rejects.toThrow()
})

test('群名片变更检测与实现能力快照', async () => {
  const s = setup()
  const first = s.client.groupCard('100', 'Alice')
  const concurrent = s.client.groupCard('100', 'Alice')
  await Bun.sleep(0)
  s.respond(0, true)
  await Promise.all([first, concurrent])
  await s.client.groupCard('100', 'Alice')
  expect(s.calls.length).toBe(1)
  const change = s.client.groupCard('100', 'Bob')
  await Bun.sleep(0)
  s.respond(1, true)
  await change
  expect(s.calls[1]).toMatchObject({ action: 'set_group_card', params: { group_id: 100, user_id: 999, card: 'Bob' } })
  expect(implementationCapabilities('NapCat')).toMatchObject({
    avatar: 'supported',
    shortDescription: 'unsupported',
    draftStreaming: 'unsupported',
  })
  expect(implementationCapabilities('Other')).toMatchObject({
    avatar: 'unknown',
    groupCard: 'supported',
    friendRequest: 'supported',
    leaveGroup: 'supported',
  })
})

test('在线状态至少间隔一分钟；快速结束的生成不会稍后错误地显示忙碌', async () => {
  const { OneBotStatus } = await import('./status')
  let now = 0
  const writes: number[] = []
  const tasks = new Map<number, () => void>()
  const delays: number[] = []
  let sequence = 0
  const status = new OneBotStatus(
    async (value) => {
      writes.push(value)
    },
    {
      now: () => now,
      schedule: ((fn: () => void, ms: number) => {
        delays.push(ms)
        tasks.set(++sequence, fn)
        return sequence
      }) as unknown as typeof setTimeout,
      cancel: ((id: number) => {
        tasks.delete(id)
      }) as unknown as typeof clearTimeout,
      sleep: async (ms) => {
        now += ms
      },
    },
  )
  status.follow(10)
  tasks.get(1)!()
  await Bun.sleep(0)
  now = 1000
  status.follow(50)
  expect(delays.at(-1)).toBe(59000)
  status.follow(10)
  expect(tasks.has(2)).toBe(false)
  status.follow(50)
  now = 60000
  tasks.get(3)!()
  await Bun.sleep(0)
  await status.leaving()
  expect(now).toBe(120000)
  expect(writes).toEqual([10, 50, 30])
})

test('群名片失败后可重试，排队的变更使用最新已应用值比较', async () => {
  const s = setup()
  const first = s.client.groupCard('100', 'Alice')
  const rejected = expect(first).rejects.toThrow()
  const retry = s.client.groupCard('100', 'Alice')
  const change = s.client.groupCard('100', 'Bob')
  await Bun.sleep(0)
  s.respond(0, null, 100)
  await rejected
  await Bun.sleep(0)
  s.respond(1, true)
  await retry
  await Bun.sleep(0)
  s.respond(2, true)
  await change
  await s.client.groupCard('100', 'Bob')
  expect(s.calls.map((call) => call.params.card)).toEqual(['Alice', 'Alice', 'Bob'])
})
