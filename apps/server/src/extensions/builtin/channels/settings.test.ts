import { expect, test } from 'bun:test'
import { channelAccountInput, channelBindingInput, channelSettingsOverrideSchema } from '@nobot/shared'
import { locationKey, matchChannelBinding, resolveChannelSettings } from './settings'

test('三层设置按键覆盖并保留 false 与来源', () => {
  const result = resolveChannelSettings(
    { settings: { stream: false, streamIntervalMs: 2000 } },
    { settings: { streamIntervalMs: 3000 } },
    { mirrorWebMessages: false },
  )
  expect(result.values).toMatchObject({
    stream: false,
    streamIntervalMs: 3000,
    mirrorWebMessages: false,
    reactions: false,
  })
  expect(result.provenance).toMatchObject({
    stream: 'account',
    streamIntervalMs: 'binding',
    mirrorWebMessages: 'global',
    reactions: 'global',
  })
})
test('隔离键严格区分 actor、topic、位置且不存在分隔符碰撞', () => {
  const a = { scope: 'group', chat: '-1', thread: '2', actor: '3' }
  expect(locationKey(a, 'shared')).toBe(locationKey({ ...a, actor: '4', thread: '5' }, 'shared'))
  expect(locationKey(a, 'per-user')).not.toBe(locationKey({ ...a, actor: '4' }, 'per-user'))
  expect(locationKey(a, 'per-topic')).not.toBe(locationKey({ ...a, thread: '5' }, 'per-topic'))
  expect(locationKey({ scope: 'a|b', chat: 'c' }, 'dm')).not.toBe(locationKey({ scope: 'a', chat: 'b|c' }, 'dm'))
})
test('公开介绍清洗描述首段、解析人名宏并保留显式字段行为', async () => {
  await import('../../registry')
  const { publicIntro } = await import('./presence')
  const character = {
    name: 'Alice',
    description: '{{char}} greets {{user}}.\n\nPRIVATE DEFINITION',
    extensions: { system_prompt: 'TOP SECRET' },
  }
  expect(publicIntro(character, false, 512)).toBe('Alice greets you.')
  expect(
    publicIntro({ ...character, extensions: { nobot: { publicIntro: '😀'.repeat(600) } } }, false, 512),
  ).toHaveLength(1024)
  expect(publicIntro({ ...character, extensions: { nobot: { publicShortIntro: 'Public only' } } }, true, 120)).toBe(
    'Public only',
  )
})
test('资料配置默认不接管、各语言覆盖不携带凭据或完整卡片', async () => {
  const { desiredPresence } = await import('./presence')
  const config = channelAccountInput.parse({
    name: 'bot',
    credentials: { token: 'SECRET' },
    presence: { name: { mode: 'custom', value: 'Bot', languages: { zh: '机器人', en: 'Bot EN' } } },
  })
  const row = {
    id: '1',
    ...config,
    credentials: 'encrypted',
    config,
    status: 'stopped' as const,
    lastError: null,
    cursor: null,
    botId: null,
    botUsername: null,
    botSnapshot: {},
    presenceSync: {},
    managedBy: null,
  }
  expect(desiredPresence(row)).toEqual({ 'name:': 'Bot', 'name:zh': '机器人', 'name:en': 'Bot EN' })
  expect(config.presence.confirmed).toBe(false)
})

test('新增话题优先于原群共享绑定，其他话题仍回到共享绑定', () => {
  const shared = { scope: 'group', chat: '-1', thread: '', actor: '', isolation: 'shared' as const }
  const topic = { ...shared, thread: '2', isolation: 'per-topic' as const }
  expect(matchChannelBinding([shared, topic], { scope: 'group', chat: '-1', thread: '2' })).toBe(topic)
  expect(matchChannelBinding([shared, topic], { scope: 'group', chat: '-1', thread: '3' })).toBe(shared)
})

test('账号和绑定只解析显式设置，空对象不注入默认值', () => {
  const account = channelAccountInput.parse({
    name: 'bot',
    credentials: { token: 'secret' },
    settings: { stream: false },
  })
  expect(account.settings).toEqual({ stream: false })
  expect(channelSettingsOverrideSchema.parse({})).toEqual({})
  const binding = channelBindingInput.parse({ accountId: 'a', scope: 'group', chat: '-1', chatId: 'c', settings: {} })
  expect(binding.settings).toEqual({})
  expect(channelBindingInput.partial().parse({ settings: { stream: false } }).settings).toEqual({ stream: false })
  expect(resolveChannelSettings(account, binding, {}).provenance.thinking).toBe('global')
  expect(channelSettingsOverrideSchema.safeParse({ streamIntervalMs: 1 }).success).toBe(false)
})

test('CH2a 媒体默认值、三层覆盖和按群聊范围默认回显', () => {
  const dm = resolveChannelSettings({}, { scope: 'private' })
  const group = resolveChannelSettings({}, { scope: 'group', settings: { cg: 'spoiler' } })
  expect(dm.values).toMatchObject({
    voice: 'button',
    voiceInput: true,
    echoTranscript: false,
    sprites: 'off',
    cg: 'send',
    generatedImages: 'send',
    background: false,
    statusCard: 'off',
    diceAnimation: false,
  })
  expect(group.values.echoTranscript).toBe(true)
  expect(group.values.cg).toBe('spoiler')
  expect(group.provenance.cg).toBe('binding')
  expect(
    resolveChannelSettings({ settings: { echoTranscript: true } }, { scope: 'private' }).values.echoTranscript,
  ).toBe(true)
  expect(resolveChannelSettings({}, { scope: 'group' }, { echoTranscript: false }).values.echoTranscript).toBe(false)
})

test('纯语音设置默认值和三层逐键覆盖', () => {
  expect(resolveChannelSettings({}, {}).values).toMatchObject({
    voice: 'button',
    voiceNarration: 'text',
    voiceLongText: 'split',
    voiceMaxChars: 300,
  })
  const result = resolveChannelSettings(
    { settings: { voice: 'only', voiceNarration: 'speak' } },
    { settings: { voiceNarration: 'drop', voiceMaxChars: 120 } },
    { voiceLongText: 'text', voiceMaxChars: 200 },
  )
  expect(result.values).toMatchObject({
    voice: 'only',
    voiceNarration: 'drop',
    voiceLongText: 'text',
    voiceMaxChars: 120,
  })
  expect(result.provenance).toMatchObject({
    voice: 'account',
    voiceNarration: 'binding',
    voiceLongText: 'global',
    voiceMaxChars: 'binding',
  })
})
