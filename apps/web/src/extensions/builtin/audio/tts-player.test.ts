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

test('预取复用结果和在途请求，预热音频且不播放浏览器语音', async () => {
  const { spyOn } = await import('bun:test')
  const warm = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('audio'))
  const result = deferred<TtsLineResult>()
  let requests = 0
  const engine = new AudioEngine()
  const played: unknown[] = []
  engine.playVoice = async (source) => {
    played.push(source)
    return 'ended'
  }
  const player = new TtsPlayer(
    {
      ...ttsApi,
      line: () => {
        requests++
        return result.promise
      },
    },
    engine,
  )
  try {
    const first = player.prefetchLine('chat', { kind: 'npc', name: 'Bob' }, 'Hi', 'joy')
    const second = player.prefetchLine('chat', { kind: 'npc', name: 'Bob' }, 'Hi', 'joy')
    const speaking = player.speakLine('chat', { kind: 'npc', name: 'Bob' }, 'Hi', 'joy')
    expect(requests).toBe(1)
    expect(played).toHaveLength(0)
    result.resolve({ kind: 'audio', url: '/voice' })
    await Promise.all([first, second, speaking])
    await player.speakLine('chat', { kind: 'npc', name: 'Bob' }, 'Hi', 'joy')
    expect(requests).toBe(1)
    expect(warm).toHaveBeenCalledWith('/voice')
    expect(played).toEqual([{ url: '/voice' }, { url: '/voice' }])
    const browser = new TtsPlayer(
      { ...ttsApi, line: async () => ({ kind: 'browser', voice: 'v', speed: 1, text: 'Hi' }) },
      engine,
    )
    await browser.prefetchLine('chat', { kind: 'narrator' }, 'Hi')
    expect(warm).toHaveBeenCalledTimes(1)
    expect(played).toHaveLength(2)
  } finally {
    warm.mockRestore()
  }
})

test('预取失败静默，等待中的朗读重新请求；缓存按访问顺序限制为 200 条', async () => {
  const { spyOn } = await import('bun:test')
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  let requests = 0
  const engine = new AudioEngine()
  engine.playVoice = async () => 'ended'
  const player = new TtsPlayer(
    {
      ...ttsApi,
      line: async (): Promise<TtsLineResult> => {
        if (++requests === 1) throw new Error('offline')
        return { kind: 'browser', voice: 'v', speed: 1, text: 'Hi' }
      },
    },
    engine,
  )
  try {
    const prefetch = player.prefetchLine('chat', { kind: 'narrator' }, 'Hi')
    await player.speakLine('chat', { kind: 'narrator' }, 'Hi')
    await prefetch
    expect(requests).toBe(2)
    expect(warn).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 200; i++) await player.prefetchLine('chat', { kind: 'narrator' }, `${i}`)
    await player.speakLine('chat', { kind: 'narrator' }, '0')
    await player.prefetchLine('chat', { kind: 'narrator' }, '200')
    const count = requests
    await player.speakLine('chat', { kind: 'narrator' }, '0')
    expect(requests).toBe(count)
    await player.speakLine('chat', { kind: 'narrator' }, '1')
    expect(requests).toBe(count + 1)
    await player.speakLine('other', { kind: 'narrator' }, '0')
    await player.speakLine('chat', { kind: 'user' }, '0')
    await player.speakLine('chat', { kind: 'narrator' }, '0', 'joy')
    expect(requests).toBe(count + 4)
  } finally {
    warn.mockRestore()
  }
})
