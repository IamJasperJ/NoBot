import { expect, test } from 'bun:test'
import { parseCues, renderDelivery } from '@nobot/core'
import { chatVoiceConfigSchema, type Delivery } from '@nobot/shared'
import { createTtsEngines } from './engines'
import { audioSettings } from './settings'

const delivery: Delivery = { tone: 'sad', intensity: 1, volume: 'whisper', direction: 'holding back tears' }

test('设置迁移、显式模式优先和会话覆盖契约', () => {
  for (const [input, expected] of [
    [{}, 'basic'],
    [{ expressionStyle: true }, 'basic'],
    [{ expressionStyle: false }, 'off'],
    [{ expressionStyle: false, deliveryMode: 'rich' }, 'rich'],
  ] as const) {
    const parsed = audioSettings.parse(input)
    expect(parsed.deliveryMode).toBe(expected)
    expect(parsed).not.toHaveProperty('expressionStyle')
  }
  expect(chatVoiceConfigSchema.parse({ deliveryMode: 'off' }).deliveryMode).toBe('off')
})

test('能力随模型、火山资源和 CosyVoice 预设变化', () => {
  const engines = createTtsEngines({ mock: true })
  const s = audioSettings.parse({
    cosyvoiceVoices: [
      { id: 'instruct', name: '', mode: 'instruct' },
      { id: 'sft', name: '', mode: 'sft' },
      { id: 'zero', name: '', mode: 'zero_shot' },
    ],
  })
  expect(engines.openai.deliveryCapabilities({ ...s, openaiModel: 'tts-1-hd' }).emotion).toBe('none')
  for (const model of ['eleven_v3', 'eleven_v4'])
    expect(engines.elevenlabs.deliveryCapabilities({ ...s, elevenlabsModel: model }).direction).toBe(true)
  expect(engines.elevenlabs.deliveryCapabilities(s).cues).toEqual([])
  expect(engines.minimax.deliveryCapabilities({ ...s, minimaxModel: 'speech-2.6-hd' }).volume).toBe(true)
  expect(engines.minimax.deliveryCapabilities({ ...s, minimaxModel: 'speech-2.8-hd' })).toMatchObject({
    volume: false,
    cues: expect.arrayContaining(['sob']),
  })
  expect(engines.minimax.deliveryCapabilities(s).cues).toEqual([])
  for (const id of ['sft', 'zero']) expect(engines.cosyvoice.deliveryCapabilities(s, id).emotion).toBe('none')
  expect(engines.cosyvoice.deliveryCapabilities(s, 'instruct').cues).toEqual(['laugh', 'breath'])
  expect(
    engines.volcengine.deliveryCapabilities({ ...s, volcengineResourceId: 'seed-tts-2.0-standard' }).direction,
  ).toBe(false)
})

test('注入 fetch 验证每类 HTTP 引擎的渲染后请求', async () => {
  const calls: { url: string; body: unknown }[] = []
  const engines = createTtsEngines({
    mock: false,
    fetch: (async (url, init) => {
      calls.push({
        url: String(url),
        body: init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(String(init?.body)),
      })
      if (String(url).includes('t2a_v2'))
        return Response.json({ base_resp: { status_code: 0 }, data: { audio: '494433' } })
      if (String(url).includes('unidirectional')) return new Response('{"code":0,"data":"SUQz"}')
      return new Response(new Uint8Array([1, 0]))
    }) as typeof fetch,
  })
  const settings = audioSettings.parse({
    openaiApiKey: 'key',
    fishApiKey: 'key',
    gptsovitsVoices: [
      { id: 'voice', refAudioPath: '/normal.wav', emotionRefs: [{ tone: 'sad', refAudioPath: '/sad.wav' }] },
    ],
    cosyvoiceVoices: [{ id: 'voice', name: '', mode: 'instruct' }],
  })
  const run = async (id: keyof typeof engines, overrides: Partial<typeof settings> = {}) => {
    const s = { ...settings, ...overrides }
    const rendered = renderDelivery(
      engines[id].deliveryCapabilities(s, 'voice'),
      delivery,
      parseCues('[hello]<laugh/><breath/><sob/> world'),
    )
    await engines[id].synthesize({ voice: 'voice', speed: 1.2, ...rendered }, s)
    return calls.at(-1)?.body
  }
  expect(await run('openai')).toMatchObject({
    input: '[hello] world',
    instructions: expect.stringContaining('slightly sad'),
  })
  expect(await run('openai', { openaiModel: 'tts-1' })).not.toHaveProperty('instructions')
  expect(await run('elevenlabs', { elevenlabsModel: 'eleven_v4' })).toMatchObject({
    text: '[slightly sad] [whispering] [holding back tears] 【hello】[laughs][breathes][sobbing] world',
  })
  expect(await run('elevenlabs')).toMatchObject({
    text: '[hello] world',
    voice_settings: { speed: 1.2, style: 0.2, stability: 0.6 },
  })
  expect(await run('fish')).toMatchObject({
    text: '[slightly sad tone] [whispering] [holding back tears] 【hello】[laughing][sobbing] world',
  })
  expect(await run('fish', { fishModel: 's1' })).toMatchObject({ text: '(sad) (whispering) [hello](laughing) world' })
  expect(await run('minimax', { minimaxModel: 'speech-2.8-turbo' })).toMatchObject({
    text: '[hello](laughs)(breath)(sniffs) world',
    voice_setting: { emotion: 'sad' },
  })
  expect(await run('minimax', { minimaxModel: 'speech-2.6-hd' })).toMatchObject({
    text: '[hello] world',
    voice_setting: { emotion: 'whisper' },
  })
  expect(await run('minimax')).toMatchObject({ text: '[hello] world', voice_setting: { emotion: 'sad' } })
  expect(await run('volcengine')).toMatchObject({
    req_params: { text: '[hello] world', audio_params: { emotion: 'sad', emotion_scale: 2 } },
  })
  expect(await run('cosyvoice')).toMatchObject({
    tts_text: '【hello】[laughter][breath] world',
    instruct_text: expect.stringContaining('holding back tears'),
  })
  expect(
    await run('cosyvoice', {
      cosyvoiceVoices: [{ id: 'voice', name: '', mode: 'sft', spkId: '', promptText: '', refTrackId: '' }],
    }),
  ).toEqual({ tts_text: '[hello] world', spk_id: '' })
  expect(await run('gptsovits')).toMatchObject({ text: '[hello] world', ref_audio_path: '/sad.wav' })
})
