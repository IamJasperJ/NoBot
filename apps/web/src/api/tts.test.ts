import { expect, spyOn, test } from 'bun:test'
import type { QueryObserverOptions } from '@tanstack/react-query'
import { setupHooks } from './hooks.test-utils'
import {
  browserVoices,
  ttsApi,
  useChatVoice,
  useFishVoiceSearch,
  useInferChatGenders,
  useRefreshFishVoices,
  useResetChatVoice,
  useSetChatVoice,
  useTtsEngines,
  useTtsVoices,
} from './tts'

test('TTS 客户端编码角色路径、发送草稿与分段参数、传递取消信号和后端错误', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init })
        return Response.json({ options: [] })
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch,
  )
  try {
    const signal = new AbortController().signal
    await ttsApi.voices('edge', { openaiApiKey: 'draft' }, signal)
    expect(calls[0]?.url).toBe('/api/ext/audio/tts/voices')
    expect(calls[0]?.init?.signal).toBe(signal)
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ engine: 'edge', settings: { openaiApiKey: 'draft' } })
    await ttsApi.setCharacterVoice({ id: 'a/b', voice: null })
    expect(calls[1]?.url).toEndWith('/voice/character/a%2Fb')
    expect(calls[1]?.init?.method).toBe('PUT')
    await ttsApi.line({ chatId: 'chat', speaker: { kind: 'npc', name: 'Alice' }, text: 'Hello' }, signal)
    expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({ speaker: { kind: 'npc', name: 'Alice' } })
    await ttsApi.chatVoice('a/b', signal)
    expect(calls[3]?.url).toEndWith('/chat/a%2Fb')
    expect(calls[3]?.init?.signal).toBe(signal)
    await ttsApi.setChatVoice({ chatId: 'a/b', config: { enabled: false, characters: {}, npcs: {} } })
    expect(calls[4]?.init?.method).toBe('PUT')
    expect(JSON.parse(String(calls[4]?.init?.body))).toEqual({ enabled: false, characters: {}, npcs: {} })
    await ttsApi.resetChatVoice('a/b')
    expect(calls[5]?.init?.method).toBe('DELETE')
    fetcher.mockImplementation(
      Object.assign(
        async () => Response.json({ error: { code: 'TTS_DISABLED', message: '还没有开启朗读' } }, { status: 400 }),
        { preconnect: fetch.preconnect },
      ) as typeof fetch,
    )
    await expect(ttsApi.preview({ voice: { engine: 'browser', voice: 'test', speed: 1 } })).rejects.toMatchObject({
      code: 'TTS_DISABLED',
    })
  } finally {
    fetcher.mockRestore()
  }
})
test('TTS hooks 读取查询缓存，服务端渲染没有浏览器语音时返回空列表', () => {
  const { qc, render } = setupHooks()
  const engines = [
    {
      id: 'browser' as const,
      label: 'Browser',
      configured: true,
      delivery: {
        emotion: 'prosody' as const,
        intensity: true,
        direction: false,
        cues: [],
        volume: true,
        format: 'prosody' as const,
      },
    },
  ]
  qc.setQueryData(['tts', 'engines'], engines)
  qc.setQueryData(['tts', 'chat', 'chat'], { effective: { enabled: false } })
  qc.setQueryData(['tts', 'voices', 'browser', undefined], [{ value: 'Alice', label: 'Alice' }])
  try {
    expect(render(() => useChatVoice('chat')).data).toMatchObject({ effective: { enabled: false } })
    expect(render(useTtsEngines).data).toEqual(engines)
    expect(render(() => useTtsVoices('browser')).data).toEqual([{ value: 'Alice', label: 'Alice' }])
    expect(browserVoices()).toEqual([])
  } finally {
    qc.clear()
  }
})

test('会话语音写入和重置后用返回值更新查询缓存', async () => {
  const { qc, render } = setupHooks()
  const dto = { config: { characters: {}, npcs: {} }, effective: { enabled: true } }
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => Response.json(dto), { preconnect: fetch.preconnect }) as typeof fetch,
  )
  try {
    await render(useSetChatVoice).mutateAsync({ chatId: 'chat', config: { characters: {}, npcs: {} } })
    expect(qc.getQueryData(['tts', 'chat', 'chat'])).toEqual(dto)
    qc.setQueryData(['tts', 'chat', 'chat'], { effective: { enabled: false } })
    qc.setQueryData(['tts', 'chat', 'other'], { marker: 'other' })
    await render(() => useInferChatGenders('chat')).mutateAsync()
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toEndWith('/chat/chat/infer-genders')
    expect(fetcher.mock.calls.at(-1)?.[1]?.method).toBe('POST')
    expect(qc.getQueryData(['tts', 'chat', 'chat'])).toEqual(dto)
    expect(qc.getQueryData(['tts', 'chat', 'other'])).toEqual({ marker: 'other' })
    await render(useResetChatVoice).mutateAsync('chat')
    expect(qc.getQueryData(['tts', 'chat', 'chat'])).toEqual(dto)
  } finally {
    fetcher.mockRestore()
    qc.clear()
  }
})

test('Fish 搜索 hook 隔离参数和草稿，传递信号，保留上一页数据，刷新仅使 Fish 声音查询失效', async () => {
  const { qc, render } = setupHooks()
  const params = { query: 'test', language: 'zh', self: false, page: 2 }
  const settings = { fishApiKey: 'draft' }
  const result = { items: [], total: 0, hasMore: false }
  const calls: { url: string; init?: RequestInit }[] = []
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init })
        return Response.json(String(url).endsWith('/refresh') ? { ok: true } : result)
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch,
  )
  try {
    const key = ['tts', 'fish', 'search', params, settings]
    const disabled = render(() => useFishVoiceSearch(params, settings, false))
    expect(disabled.fetchStatus).toBe('idle')
    expect(calls).toHaveLength(0)
    const query = qc.getQueryCache().find({ queryKey: key })!
    expect((query.options as QueryObserverOptions).enabled).toBe(false)
    const placeholder = (query.options as QueryObserverOptions).placeholderData
    expect(typeof placeholder).toBe('function')
    if (typeof placeholder === 'function') expect(placeholder(result, undefined)).toBe(result)
    await query.fetch()
    expect(calls[0]?.url).toBe('/api/ext/audio/tts/fish/search')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ ...params, settings })
    expect(render(() => useFishVoiceSearch(params, settings, true)).data).toEqual(result)
    expect((query.options as QueryObserverOptions).enabled).toBe(true)
    render(() => useFishVoiceSearch({ ...params, page: 3 }, settings, false))
    render(() => useFishVoiceSearch(params, { fishApiKey: 'other' }, false))
    expect(qc.getQueryCache().findAll({ queryKey: ['tts', 'fish', 'search'] })).toHaveLength(3)
    const fishKey = ['tts', 'voices', 'fish', settings]
    const otherKey = ['tts', 'voices', 'openai']
    qc.setQueryData(fishKey, [])
    qc.setQueryData(otherKey, [])
    await render(useRefreshFishVoices).mutateAsync()
    expect(calls.at(-1)?.url).toBe('/api/ext/audio/tts/fish/refresh')
    expect(calls.at(-1)?.init?.method).toBe('POST')
    expect(qc.getQueryState(fishKey)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(otherKey)?.isInvalidated).toBe(false)
  } finally {
    fetcher.mockRestore()
    qc.clear()
  }
})
