import { expect, test } from 'bun:test'
import { channelSettingsSchema } from '@nobot/shared'
import { resolveChannelSettings } from './settings'
import { nextVoicePreference, voiceIntent } from './voice-rules'

for (const text of [
  '发语音',
  '请用语音回复',
  '语音说晚安',
  '说给我听',
  '念给我听',
  'Send a voice message',
  'say it out loud',
]) {
  test(`单次语音请求：${text}`, () => expect(voiceIntent(text)).toBe('request'))
}
for (const text of [
  '别发语音',
  '不要语音',
  '不要发语音',
  '不要用语音',
  '不用语音',
  'no voice',
  "don't send voice",
  'do not send a voice message',
]) {
  test(`否定优先：${text}`, () => expect(voiceIntent(text)).toBe('suppress'))
}
for (const text of ['普通聊天', '我的声音好听吗', 'voice recognition', 'out loudness', 'invoice message']) {
  test(`普通文字：${text}`, () => expect(voiceIntent(text)).toBeUndefined())
}
test('偏好逐级提升、禁止、恢复，非 decide 模式忽略', () => {
  const settings = channelSettingsSchema.parse({ voice: 'decide', voiceDecideBias: 'low' })
  const first = nextVoicePreference(undefined, 'more voice', settings, 1)
  expect(first).toEqual({ bias: 'medium', updatedAt: 1 })
  const second = nextVoicePreference(first, '多发语音', settings, 2)
  expect(second?.bias).toBe('high')
  expect(nextVoicePreference(second, '以后都发语音', settings, 3)?.bias).toBe('high')
  const muted = nextVoicePreference(second, '别发语音', settings, 4)
  expect(muted?.suppressed).toBe(true)
  expect(nextVoicePreference(muted, '可以发语音', settings, 5)?.suppressed).toBe(false)
  for (const voice of ['off', 'button', 'only', 'auto'] as const)
    expect(nextVoicePreference(undefined, 'no voice', { ...settings, voice }, 6)).toBeUndefined()
})

test('语音决策默认值与三层覆盖', () => {
  const defaults = channelSettingsSchema.parse({})
  expect([defaults.voiceDecideBias, defaults.voiceDecideStyle, defaults.voiceDecideHourlyMax]).toEqual([
    'medium',
    'only',
    10,
  ])
  const resolved = resolveChannelSettings(
    { settings: { voiceDecideBias: 'high', voiceDecideHourlyMax: 5 } },
    { settings: { voice: 'decide', voiceDecideHourlyMax: 0 } },
    { voiceDecideBias: 'low', voiceDecideStyle: 'with-text' },
  )
  expect([
    resolved.values.voice,
    resolved.values.voiceDecideBias,
    resolved.values.voiceDecideStyle,
    resolved.values.voiceDecideHourlyMax,
  ]).toEqual(['decide', 'high', 'with-text', 0])
  expect(resolved.provenance.voiceDecideBias).toBe('account')
  expect(resolved.provenance.voiceDecideStyle).toBe('global')
  expect(resolved.provenance.voiceDecideHourlyMax).toBe('binding')
})
