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
  expect(useTtsPlayer.getState()).toEqual({ messageId: 'message', chatId: 'chat', playing: true })
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

test('stopChat 只停止对应会话的准备或播放，结束后清空归属', async () => {
  const result = deferred<TtsLineResult>()
  const engine = new AudioEngine()
  let plays = 0
  engine.playVoice = async () => {
    plays++
    return 'ended'
  }
  const player = new TtsPlayer({ ...ttsApi, line: () => result.promise }, engine)
  const task = player.speakLine('a', { kind: 'narrator' }, 'hello')
  expect(useTtsPlayer.getState().chatId).toBe('a')
  player.stopChat('b')
  expect(useTtsPlayer.getState().playing).toBe(true)
  player.stopChat('a')
  expect(useTtsPlayer.getState()).toEqual({ messageId: null, chatId: null, playing: false })
  result.resolve({ kind: 'audio', url: 'late' })
  await task
  expect(plays).toBe(0)
  await player.speakLine('b', { kind: 'narrator' }, 'hello')
  expect(plays).toBe(1)
  expect(useTtsPlayer.getState().chatId).toBeNull()
})

test('消息请求期间离开会话，已知和未知归属的迟到结果都不能播放', async () => {
  for (const known of [true, false]) {
    const response = deferred<Awaited<ReturnType<typeof ttsApi.message>>>()
    const engine = new AudioEngine()
    let synthesized = 0
    const player = new TtsPlayer(
      {
        ...ttsApi,
        message: () => response.promise,
        line: async () => {
          synthesized++
          return { kind: 'skip', reason: 'no-voice' }
        },
      },
      engine,
    )
    const task = player.speakMessage('m', known ? 'a' : null)
    player.stopChat('other')
    expect(useTtsPlayer.getState().playing).toBe(true)
    player.stopChat('a')
    response.resolve({ chatId: 'a', segments: [{ speaker: { kind: 'narrator' }, text: 'hello' }] })
    await task
    expect(synthesized).toBe(0)
    expect(useTtsPlayer.getState()).toEqual({ messageId: null, chatId: null, playing: false })
  }
})

test('正在播放时 stopChat 仅中断对应会话，旧请求完成不清空新播放状态', async () => {
  const ending = deferred<'ended'>()
  const nextEnding = deferred<'ended'>()
  const engine = new AudioEngine()
  let stops = 0
  let plays = 0
  engine.playVoice = () => (++plays === 1 ? ending.promise : nextEnding.promise)
  engine.stopVoice = () => {
    stops++
  }
  const result = deferred<TtsLineResult>()
  const player = new TtsPlayer({ ...ttsApi, line: () => result.promise }, engine)
  const first = player.speakLine('a', { kind: 'narrator' }, 'first')
  result.resolve({ kind: 'audio', url: 'voice' })
  await flush()
  const before = stops
  player.stopChat('b')
  expect(stops).toBe(before)
  expect(useTtsPlayer.getState().chatId).toBe('a')
  player.stopChat('a')
  expect(stops).toBe(before + 1)
  const second = player.speakLine('b', { kind: 'narrator' }, 'second')
  await flush()
  ending.resolve('ended')
  await first
  // 旧任务的 finally 不能提前清掉后启动任务的归属。
  expect(useTtsPlayer.getState().chatId).toBe('b')
  expect(useTtsPlayer.getState().playing).toBe(true)
  nextEnding.resolve('ended')
  await second
  expect(useTtsPlayer.getState()).toEqual({ messageId: null, chatId: null, playing: false })
})

test('逐句演绎和声音透传，预取缓存随演绎和插入点变化', async () => {
  const inputs: Parameters<typeof ttsApi.line>[0][] = []
  const engine = new AudioEngine()
  engine.playVoice = async () => 'ended'
  const player = new TtsPlayer(
    {
      ...ttsApi,
      line: async (input) => {
        inputs.push(input)
        return { kind: 'browser', voice: 'v', speed: 1, text: input.text }
      },
    },
    engine,
  )
  const speaker = { kind: 'npc' as const, name: 'Alice' }
  const delivery = { volume: 'whisper' as const, direction: 'holding back tears' }
  const cues = [{ at: 0, cue: 'sigh' as const }]
  await player.prefetchLine('chat', speaker, 'Hi', 'sadness', delivery, cues)
  await player.speakLine('chat', speaker, 'Hi', 'sadness', delivery, cues)
  expect(inputs).toEqual([{ chatId: 'chat', speaker, text: 'Hi', expression: 'sadness', delivery, cues }])
  await player.speakLine('chat', speaker, 'Hi', 'sadness', { volume: 'shout' }, cues)
  await player.speakLine('chat', speaker, 'Hi', 'sadness', delivery, [])
  expect(inputs).toHaveLength(3)
})

test('合成接口失败保留原始 message，播放成功清除；skip 不清除最近错误', async () => {
  const { useVnVoiceStore } = await import('../../../stores/vnVoice')
  const { spyOn } = await import('bun:test')
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({ error: { message: '语音服务尚未配置' } }, { status: 400 }),
  )
  const engine = new AudioEngine()
  engine.playVoice = async () => 'ended'
  const player = new TtsPlayer(ttsApi, engine)
  try {
    await expect(player.speakLine('chat', { kind: 'narrator' }, 'bad')).rejects.toThrow('语音服务尚未配置')
    expect(useVnVoiceStore.getState().lastVoiceError?.message).toBe('语音服务尚未配置')
    fetch.mockResolvedValueOnce(Response.json({ kind: 'skip', reason: 'no-voice' }))
    await player.speakLine('chat', { kind: 'narrator' }, 'skip')
    expect(useVnVoiceStore.getState().lastVoiceError?.message).toBe('语音服务尚未配置')
    fetch.mockResolvedValueOnce(Response.json({ kind: 'audio', url: '/ok' }))
    await player.speakLine('chat', { kind: 'narrator' }, 'ok')
    expect(useVnVoiceStore.getState().lastVoiceError).toBeNull()
  } finally {
    fetch.mockRestore()
  }
})

test('blocked 结束消息后不读下一段，也不抛给手动朗读 toast；error 仍拒绝', async () => {
  const { useVnVoiceStore } = await import('../../../stores/vnVoice')
  const engine = new AudioEngine()
  let plays = 0
  engine.playVoice = async () => {
    plays++
    return 'blocked'
  }
  const player = new TtsPlayer(
    {
      ...ttsApi,
      message: async () => ({
        chatId: 'chat',
        segments: ['first', 'second'].map((text) => ({ speaker: { kind: 'narrator' as const }, text })),
      }),
      line: async () => ({ kind: 'audio', url: '/voice' }),
    },
    engine,
  )
  useVnVoiceStore.setState({ lastVoiceError: null })
  await player.speakMessage('m')
  expect(plays).toBe(1)
  expect(useVnVoiceStore.getState().lastVoiceError).toBeNull()
  await player.speakLine('chat', { kind: 'narrator' }, 'blocked')
  engine.playVoice = async () => 'error'
  await expect(player.speakMessage('m')).rejects.toThrow('语音播放失败')
  expect(useVnVoiceStore.getState().lastVoiceError?.message).toBe('语音播放失败')
})
