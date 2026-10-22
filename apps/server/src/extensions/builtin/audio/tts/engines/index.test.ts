import { expect, test } from 'bun:test'
import { audioSettings } from '../settings'
import { createTtsEngines } from './index'

const input = { text: '你好', voice: 'custom', speed: 1.5, tone: 'happy' as const }
test('MiniMax：请求格式、hex 解码与鉴权错误', async () => {
  let code = 0
  const engines = createTtsEngines({
    mock: false,
    fetch: (async (url, init) => {
      expect(url).toBe('https://api.minimaxi.com/v1/t2a_v2')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret')
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'speech-02-hd',
        text: '你好',
        stream: false,
        voice_setting: { voice_id: 'custom', speed: 1.5, vol: 1, pitch: 0, emotion: 'happy' },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      })
      return Response.json({ base_resp: { status_code: code }, data: { audio: '494433ff' } })
    }) as typeof fetch,
  })
  const settings = audioSettings.parse({ minimaxApiKey: 'secret' })
  expect((await engines.minimax.synthesize(input, settings)).bytes).toEqual(Buffer.from([73, 68, 51, 255]))
  code = 1004
  await expect(engines.minimax.synthesize(input, settings)).rejects.toMatchObject({ code: 'TTS_AUTH_FAILED' })
  code = 12
  await expect(engines.minimax.synthesize(input, settings)).rejects.toThrow()
})
test('火山：语速边界、情感、additions 和多行流（无末尾换行）', async () => {
  let error = false
  const rates: number[] = []
  const engines = createTtsEngines({
    mock: false,
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      rates.push(body.req_params.audio_params.speech_rate)
      expect(body.req_params.audio_params.emotion).toBe('fear')
      expect(body.req_params.audio_params.emotion_scale).toBe(4)
      expect(body.req_params.audio_params.sample_rate).toBe(24000)
      expect(JSON.parse(body.req_params.additions)).toEqual({
        context_texts: ['Speak in a fearful tone.'],
        mute_cut_threshold: '400',
        mute_cut_remain_ms: '1',
        explicit_language: 'crosslingual',
        enable_language_detector: true,
        disable_markdown_filter: true,
        cache_config: { use_cache: true, text_type: 1 },
      })
      expect(new Headers(init?.headers).get('X-Api-Resource-Id')).toBe('seed-tts-2.0')
      const text = `{"code":0,"data":"SUQ="}\n\n{"code":${error ? 42 : 20000000},"data":"Mw=="}`
      return new Response(
        new ReadableStream({
          start(c) {
            const bytes = new TextEncoder().encode(text)
            c.enqueue(bytes.slice(0, 12))
            c.enqueue(bytes.slice(12))
            c.close()
          },
        }),
      )
    }) as typeof fetch,
  })
  for (const speed of [0.5, 1, 2])
    expect(
      (await engines.volcengine.synthesize({ ...input, speed, tone: 'fearful' }, audioSettings.parse({}))).bytes,
    ).toEqual(Buffer.from('ID3'))
  expect(rates).toEqual([-50, 0, 100])
  error = true
  await expect(engines.volcengine.synthesize({ ...input, tone: 'fearful' }, audioSettings.parse({}))).rejects.toThrow()
})
test('CosyVoice：multipart 与 PCM 加 WAV 头，sft/instruct 分流', async () => {
  const engines = createTtsEngines({
    mock: false,
    fetch: (async (url, init) => {
      expect(init?.body).toBeInstanceOf(FormData)
      const form = init?.body as FormData
      expect(form.get('tts_text')).toBe('你好')
      expect(form.get('spk_id')).toBe('speaker')
      if (String(url).endsWith('instruct')) expect(form.get('instruct_text')).toBe('Speak in a happy tone.')
      else expect(form.has('instruct_text')).toBe(false)
      expect(new Headers(init?.headers).has('Content-Type')).toBe(false)
      return new Response(new Uint8Array([1, 0, 255, 127]))
    }) as typeof fetch,
  })
  for (const mode of ['sft', 'instruct'] as const) {
    const settings = audioSettings.parse({
      cosyvoiceSampleRate: 24000,
      cosyvoiceVoices: [{ id: 'custom', name: 'Custom', mode, spkId: 'speaker' }],
    })
    const result = await engines.cosyvoice.synthesize(input, settings)
    const bytes = Buffer.from(result.bytes)
    expect(result.mime).toBe('audio/wav')
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
    expect(bytes.readUInt32LE(4)).toBe(40)
    expect(bytes.readUInt32LE(24)).toBe(24000)
    expect(bytes.readUInt16LE(22)).toBe(1)
    expect(bytes.readUInt16LE(34)).toBe(16)
    expect(bytes.readUInt32LE(40)).toBe(4)
    expect([...bytes.subarray(44)]).toEqual([1, 0, 255, 127])
  }
})
test('新引擎都接入离线模拟', async () => {
  const engines = createTtsEngines({
    mock: true,
    fetch: (() => {
      throw new Error('不应联网')
    }) as unknown as typeof fetch,
  })
  const settings = audioSettings.parse({ cosyvoiceVoices: [{ id: 'custom', name: 'Custom' }] })
  for (const id of ['minimax', 'volcengine', 'cosyvoice'] as const)
    expect((await engines[id].synthesize(input, settings)).mime).toBe('audio/wav')
})
test('现有引擎使用标准语气：OpenAI、Eleven v3、GPT-SoVITS 参考替换', async () => {
  const calls: Record<string, unknown>[] = []
  const engines = createTtsEngines({
    mock: false,
    fetch: (async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)))
      return new Response('ID3')
    }) as typeof fetch,
  })
  const settings = audioSettings.parse({
    openaiApiKey: 'key',
    elevenlabsModel: 'eleven_v3',
    gptsovitsVoices: [
      {
        id: 'custom',
        name: 'Custom',
        refAudioPath: '/normal.wav',
        emotionRefs: [{ tone: 'happy', refAudioPath: '/happy.wav', promptText: 'Happy' }],
      },
    ],
  })
  await engines.openai.synthesize({ ...input, style: 'happy' }, settings)
  await engines.elevenlabs.synthesize(input, settings)
  await engines.elevenlabs.synthesize(input, { ...settings, elevenlabsModel: 'eleven_multilingual_v2' })
  await engines.gptsovits.synthesize(input, settings)
  expect(calls[0]?.instructions).toBe('Speak in a happy tone.')
  expect(calls[1]?.text).toBe('[happy] 你好')
  expect(calls[2]?.text).toBe('你好')
  expect(calls[3]).toMatchObject({ ref_audio_path: '/happy.wav', prompt_text: 'Happy' })
})
