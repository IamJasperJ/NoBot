import { expect, test } from 'bun:test'
import type { TtsLineResult } from '@nobot/shared'
import { ttsApi } from '../../../api/tts'
import { AudioEngine } from './engine'
import { TtsPlayer, useTtsPlayer } from './tts-player'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
test('消息逐段播放，播放期间只预取下一段，跳过 skip 并清理状态', async () => {
  const requests: string[] = []
  const played: string[] = []
  const ending = deferred<'ended'>()
  const engine = new AudioEngine()
  engine.playVoice = async (source) => {
    if ('url' in source) played.push(source.url)
    return ending.promise
  }
  const api = {
    ...ttsApi,
    message: async () => ({
      chatId: 'chat',
      segments: ['one', 'two', 'three'].map((text) => ({ speaker: { kind: 'narrator' as const }, text })),
    }),
    line: async ({ text }: { text: string }): Promise<TtsLineResult> => {
      requests.push(text)
      return text === 'two' ? { kind: 'skip', reason: 'no-voice' } : { kind: 'audio', url: text }
    },
  }
  const player = new TtsPlayer(api, engine)
  const task = player.speakMessage('message')
  await flush()
  expect(requests).toEqual(['one', 'two'])
  expect(played).toEqual(['one'])
  expect(useTtsPlayer.getState()).toEqual({ messageId: 'message', playing: true })
  ending.resolve('ended')
  await task
  expect(played).toEqual(['one', 'three'])
  expect(useTtsPlayer.getState().playing).toBe(false)
})
test('停止后迟到的请求不播放，也不覆盖新队列状态；合成失败释放状态', async () => {
  const late = deferred<TtsLineResult>()
  let count = 0
  const engine = new AudioEngine()
  engine.playVoice = async () => {
    count++
    return 'ended'
  }
  const api = { ...ttsApi, line: () => late.promise }
  const player = new TtsPlayer(api, engine)
  const task = player.speakLine('chat', { kind: 'narrator' }, 'hello')
  player.stop()
  late.resolve({ kind: 'audio', url: 'late' })
  await task
  expect(count).toBe(0)
  expect(useTtsPlayer.getState().playing).toBe(false)
  api.line = () => Promise.reject(new Error('failed'))
  await expect(player.speakLine('chat', { kind: 'user' }, 'hello')).rejects.toThrow('failed')
  expect(useTtsPlayer.getState().playing).toBe(false)
})
