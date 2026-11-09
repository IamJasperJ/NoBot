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
  expect(s.transport.paused).toBe(true)
  const other = setup()
  const pending = other.transport.call('wait')
  other.transport.stop()
  await expect(pending).rejects.toThrow()
})

for (const retcode of [1404, 1400]) {
  test(`连续三次 ${retcode} 不熔断，后续调用仍能发送`, async () => {
    const s = setup()
    for (let i = 0; i < 3; i++) {
      const result = s.transport.call('probe').catch((error: unknown) => error)
      s.respond(i, null, retcode)
      expect(await result).toMatchObject({ retcode })
    }
    expect(s.transport.paused).toBe(false)
    expect(s.paused()).toBe(0)
    const next = s.transport.call('next')
    expect(s.calls).toHaveLength(4)
    expect(s.calls[3]?.action).toBe('next')
    s.respond(3, true)
    expect(await next).toBe(true)
  })

  test(`${retcode} 不重置已有失败计数`, async () => {
    const s = setup()
    const retcodes = [100, retcode, 100, retcode, 100]
    for (const [index, code] of retcodes.entries()) {
      const result = s.transport.call('failure').catch((error: unknown) => error)
      s.respond(index, null, code)
      expect(await result).toMatchObject({ retcode: code })
      expect(s.transport.paused).toBe(index === retcodes.length - 1)
    }
    expect(s.paused()).toBe(1)
  })
}

test('带风控文字的 1404 仍然熔断', async () => {
  const s = setup()
  const result = s.transport.call('probe').catch((error: unknown) => error)
  s.respond(0, null, 1404, '风控')
  expect(await result).toMatchObject({ retcode: 1404 })
  expect(s.transport.paused).toBe(true)
  expect(s.paused()).toBe(1)
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
    avatar: 'supported',
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
  const firstResult = first.catch((error: unknown) => error)
  const retry = s.client.groupCard('100', 'Alice')
  const change = s.client.groupCard('100', 'Bob')
  await Bun.sleep(0)
  s.respond(0, null, 100)
  expect(await firstResult).toBeInstanceOf(OneBotError)
  await Bun.sleep(0)
  s.respond(1, true)
  await retry
  await Bun.sleep(0)
  s.respond(2, true)
  await change
  await s.client.groupCard('100', 'Bob')
  expect(s.calls.map((call) => call.params.card)).toEqual(['Alice', 'Alice', 'Bob'])
})

test('SnowLuma 默认发送扩展动作，1404 只学习一次且后续不发送', async () => {
  const s = setup()
  s.client.implementation = { name: 'SnowLuma', version: '1' }
  const learned: string[] = []
  s.client.onActionUnsupported = (action) => learned.push(action)
  const first = s.client.action('set_qq_profile', { nickname: 'Alice' })
  expect(s.calls[0]?.action).toBe('set_qq_profile')
  const concurrent = s.client.action('set_qq_profile', { nickname: 'Bob' })
  const firstResult = first.catch((error: unknown) => error)
  const concurrentResult = concurrent.catch((error: unknown) => error)
  s.respond(0, null, 1404)
  s.respond(1, null, 1404)
  expect(await firstResult).toMatchObject({ retcode: 1404 })
  expect(await concurrentResult).toMatchObject({ retcode: 1404 })
  expect([...s.client.unsupportedActions]).toEqual(['set_qq_profile'])
  expect(learned).toEqual(['set_qq_profile'])
  expect(s.client.supports('set_qq_profile')).toBe(false)
  await expect(s.client.action('set_qq_profile')).rejects.toMatchObject({ retcode: 1404 })
  expect(s.calls).toHaveLength(2)
})

for (const retcode of [100, 1400, -1, -2]) {
  test(`扩展动作错误 ${retcode} 不记录，允许下次重试`, async () => {
    const s = setup()
    const learned: string[] = []
    s.client.onActionUnsupported = (action) => learned.push(action)
    const pending = s.client.action('set_qq_avatar')
    if (retcode !== -2) s.respond(0, null, retcode)
    await expect(pending).rejects.toMatchObject({ retcode })
    expect(s.client.unsupportedActions.size).toBe(0)
    expect(learned).toEqual([])
    expect(s.client.supports('set_qq_avatar')).toBe(true)
    const retry = s.client.action('set_qq_avatar')
    s.respond(1, true)
    await retry
    expect(s.calls).toHaveLength(2)
  })
}

test('标准动作返回 1404 仍然发送，快照误含标准动作也不会短路', async () => {
  const s = setup()
  const learned: string[] = []
  s.client.onActionUnsupported = (action) => learned.push(action)
  const first = s.client.action('send_group_msg')
  s.respond(0, null, 1404)
  await expect(first).rejects.toMatchObject({ retcode: 1404 })
  expect(s.client.unsupportedActions.size).toBe(0)
  s.client.unsupportedActions.add('send_group_msg')
  const retry = s.client.action('send_group_msg')
  s.respond(1, true)
  await retry
  expect(learned).toEqual([])
  expect(s.calls).toHaveLength(2)
})

test('扩展能力按连接记录与动作学习声明，戳一戳需两个动作均缺失', () => {
  expect(implementationCapabilities('', ['set_qq_avatar'])).toMatchObject({
    avatar: 'unknown',
    poke: 'unknown',
    essence: 'unknown',
    notice: 'unknown',
    tempSessionDm: 'unknown',
  })
  expect(implementationCapabilities('SnowLuma')).toMatchObject({
    avatar: 'supported',
    poke: 'supported',
    essence: 'permission_required',
    notice: 'permission_required',
    tempSessionDm: 'supported',
  })
  expect(
    implementationCapabilities('SnowLuma', ['set_qq_avatar', 'set_essence_msg', '_send_group_notice', 'group_poke']),
  ).toMatchObject({
    avatar: 'unsupported',
    essence: 'unsupported',
    notice: 'unsupported',
    poke: 'supported',
  })
  expect(implementationCapabilities('SnowLuma', ['friend_poke']).poke).toBe('supported')
  expect(implementationCapabilities('SnowLuma', ['group_poke', 'friend_poke']).poke).toBe('unsupported')
})

test('收藏表情真实转发与停止时 1404 降级', async () => {
  const s = setup()
  const faces = s.client.call('fetch_custom_face', { count: 1000 })
  expect(s.calls[0]).toMatchObject({ action: 'fetch_custom_face', params: { count: 1000 } })
  s.respond(0, null, 1404)
  await expect(faces).rejects.toMatchObject({ retcode: 1404 })
  const stop = s.client.prepareStop(true)
  for (let i = 0; i < 500 && s.calls.length !== 2; i++) {
    await Bun.sleep(1)
  }
  expect(s.calls).toHaveLength(2)
  s.respond(1, null, 1404)
  await stop
  expect(s.client.supports('set_online_status')).toBe(false)
  await s.client.prepareStop(true)
  expect(s.calls).toHaveLength(2)
})
