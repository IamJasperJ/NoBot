import { expect, spyOn, test } from 'bun:test'
import { setupHooks } from './hooks.test-utils'
import { browserVoices, ttsApi, useTtsEngines, useTtsVoices } from './tts'

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
  const engines = [{ id: 'browser' as const, label: 'Browser', configured: true }]
  qc.setQueryData(['tts', 'engines'], engines)
  qc.setQueryData(['tts', 'voices', 'browser', undefined], [{ value: 'Alice', label: 'Alice' }])
  try {
    expect(render(useTtsEngines).data).toEqual(engines)
    expect(render(() => useTtsVoices('browser')).data).toEqual([{ value: 'Alice', label: 'Alice' }])
    expect(browserVoices()).toEqual([])
  } finally {
    qc.clear()
  }
})
