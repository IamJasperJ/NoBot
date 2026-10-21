import { expect, spyOn, test } from 'bun:test'
import { parseCues, renderDelivery } from '@nobot/core'
import { createTtsEngines, mockAudio } from './engines'
import { cacheSettings } from './service'
import { audioSettings, cosyvoiceHeaders, ttsFields } from './settings'

const settings = () =>
  audioSettings.parse({ cosyvoiceApi: 'gateway', cosyvoiceEndpoint: 'http://gateway/api/cosyvoice3/' })

test('网关音色解析、性别、两分钟缓存及地址和请求头隔离', async () => {
  const calls: { url: string; headers: Headers }[] = []
  const engine = createTtsEngines({
    mock: false,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) })
      return Response.json({ voices: ['default', '原神_少女_刻晴', '原神_少年_温迪'] })
    }) as unknown as typeof fetch,
  }).cosyvoice
  const s = settings()
  const clock = spyOn(Date, 'now').mockReturnValue(1000)
  try {
    expect(engine.configured(s)).toBe(true)
    const voices = await engine.voices(s)
    expect(voices).toEqual([
      { value: 'default', label: 'default', gender: undefined },
      { value: '原神_少女_刻晴', label: '原神_少女_刻晴', gender: 'female' },
      { value: '原神_少年_温迪', label: '原神_少年_温迪', gender: 'male' },
    ])
    await engine.voices(s)
    clock.mockReturnValue(120999)
    await engine.voices(s)
    expect(calls).toHaveLength(1)
    clock.mockReturnValue(121000)
    await engine.voices(s)
    expect(calls).toHaveLength(2)
    await engine.voices({ ...s, cosyvoiceEndpoint: 'http://other' })
    await engine.voices({ ...s, cosyvoiceHeaders: '{"Authorization":"Bearer secret"}' })
    expect(calls).toHaveLength(4)
    expect(calls[0]?.url).toBe('http://gateway/api/cosyvoice3/voices')
    expect(calls.at(-1)?.headers.get('authorization')).toBe('Bearer secret')
    await engine.voices({ ...s, cosyvoiceHeaders: '{"authorization":"Bearer secret"}' })
    expect(calls).toHaveLength(4)
  } finally {
    clock.mockRestore()
  }
})

test('网关音色失败统一为 502 且不缓存失败', async () => {
  for (const body of [{}, { voices: [1] }, { voices: [''] }, 'invalid']) {
    let count = 0
    const engine = createTtsEngines({
      mock: false,
      fetch: (async () => {
        count++
        return typeof body === 'string' ? new Response(body) : Response.json(body)
      }) as unknown as typeof fetch,
    }).cosyvoice
    for (let i = 0; i < 2; i++)
      await expect(engine.voices(settings())).rejects.toMatchObject({ status: 502, code: 'TTS_FAILED' })
    expect(count).toBe(2)
  }
  for (const fetcher of [
    async () => new Response('', { status: 401 }),
    async () => {
      throw new Error('secret')
    },
  ]) {
    const engine = createTtsEngines({ mock: false, fetch: fetcher as unknown as typeof fetch }).cosyvoice
    await expect(engine.voices(settings())).rejects.toMatchObject({ status: 502, code: 'TTS_FAILED' })
  }
})

test('网关 speech 的演绎、cues、off、请求头与 WAV 原样返回', async () => {
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = []
  const engine = createTtsEngines({
    mock: false,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) })
      return new Response(mockAudio)
    }) as unknown as typeof fetch,
  }).cosyvoice
  const s = { ...settings(), cosyvoiceHeaders: '{"Authorization":"Bearer secret","X-Gateway":"test"}' }
  expect(engine.deliveryCapabilities(s)).toEqual({
    emotion: 'instruction',
    intensity: true,
    direction: true,
    volume: true,
    cues: ['laugh', 'breath'],
    format: 'cosyvoice',
  })
  const rendered = renderDelivery(
    engine.deliveryCapabilities(s),
    { tone: 'happy', intensity: 2, volume: 'normal', direction: 'Speak gently.' },
    parseCues('你好<laugh/><breath/>'),
  )
  const result = await engine.synthesize({ ...rendered, voice: '原神_少女_刻晴', speed: 1.2 }, s)
  expect(result).toEqual({ bytes: mockAudio, mime: 'audio/wav' })
  expect(calls[0]?.url).toBe('http://gateway/api/cosyvoice3/v1/audio/speech')
  expect(calls[0]?.body).toEqual({
    input: '你好[laughter][breath]',
    model: 'cosyvoice3',
    voice: '原神_少女_刻晴',
    speed: 1.2,
    response_format: 'wav',
    instructions: rendered.params.instructions,
  })
  expect(calls[0]?.body.instructions).toContain('Speak gently.')
  expect(calls[0]?.headers.get('content-type')).toBe('application/json')
  expect(calls[0]?.headers.get('authorization')).toBe('Bearer secret')
  expect(calls[0]?.headers.get('x-gateway')).toBe('test')
  await engine.synthesize({ ...rendered, voice: 'default', speed: 1 }, { ...s, deliveryMode: 'off' })
  expect(calls.at(-1)?.body.instructions).toBe('')
  await engine.synthesize({ text: '你好', voice: 'default', speed: 1 }, s)
  expect(calls.at(-1)?.body.instructions).toBe('')
})

test('官方模式保持预设、表单、PCM 包装并使用额外请求头', async () => {
  let call: RequestInit | undefined
  let url = ''
  const engine = createTtsEngines({
    mock: false,
    fetch: (async (target: string | URL | Request, init?: RequestInit) => {
      url = String(target)
      call = init
      return new Response(new Uint8Array([1, 0]))
    }) as unknown as typeof fetch,
  }).cosyvoice
  const s = audioSettings.parse({
    cosyvoiceHeaders: '{"X-Key":"secret"}',
    cosyvoiceVoices: [{ id: 'voice', name: '女声', mode: 'sft', spkId: 'speaker' }],
  })
  expect(engine.configured(audioSettings.parse({}))).toBe(false)
  expect(await engine.voices(s)).toEqual([{ value: 'voice', label: '女声', gender: 'female' }])
  const result = await engine.synthesize({ text: '你好', voice: 'voice', speed: 1 }, s)
  expect(url).toEndWith('/inference_sft')
  if (!(call?.body instanceof FormData)) throw new Error('应发送表单')
  expect(Object.fromEntries(call.body.entries())).toEqual({ tts_text: '你好', spk_id: 'speaker' })
  expect(new Headers(call?.headers).get('x-key')).toBe('secret')
  expect(result.bytes.length).toBe(46)
  expect(Buffer.from(result.bytes).toString('ascii', 0, 4)).toBe('RIFF')
})

test('设置显隐、请求头校验及网关缓存键', () => {
  expect(audioSettings.parse({}).cosyvoiceApi).toBe('official')
  for (const key of ['cosyvoiceSampleRate', 'cosyvoiceVoices'])
    expect(ttsFields.find((f) => f.key === key)).toMatchObject({
      visibleWhen: { key: 'cosyvoiceApi', equals: 'official' },
    })
  expect(ttsFields.find((f) => f.key === 'cosyvoiceHeaders')).not.toHaveProperty('visibleWhen')
  for (const text of ['bad', '[]', '{"x":1}']) expect(() => cosyvoiceHeaders(text)).toThrow()
  const voice = { engine: 'cosyvoice' as const, voice: 'default', speed: 1 }
  const s = settings()
  const key = cacheSettings(voice, s)
  expect(key).toMatchObject({ api: 'gateway', endpoint: s.cosyvoiceEndpoint, voice: 'default' })
  expect(key).not.toHaveProperty('preset')
  expect(cacheSettings(voice, { ...s, cosyvoiceEndpoint: 'http://changed' })).not.toEqual(key)
  expect(cacheSettings(voice, { ...s, cosyvoiceHeaders: '{"X-Key":"secret"}' })).not.toEqual(key)
  expect(JSON.stringify(cacheSettings(voice, { ...s, cosyvoiceHeaders: '{"X-Key":"secret"}' }))).not.toContain('secret')
  expect(
    cacheSettings(voice, {
      ...s,
      cosyvoiceSampleRate: 48000,
      cosyvoiceVoices: audioSettings.parse({ cosyvoiceVoices: [{ id: 'default', name: 'changed' }] }).cosyvoiceVoices,
    }),
  ).toEqual(key)
})

test('离线网关不发送任何请求', async () => {
  const engine = createTtsEngines({
    mock: true,
    fetch: (async () => {
      throw new Error('不应联网')
    }) as unknown as typeof fetch,
  }).cosyvoice
  expect(await engine.voices(settings())).toEqual([{ value: 'default', label: 'default' }])
  expect(await engine.synthesize({ text: '你好', voice: 'default', speed: 1 }, settings())).toEqual({
    bytes: mockAudio,
    mime: 'audio/wav',
  })
})
