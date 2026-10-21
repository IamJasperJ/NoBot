import { expect, spyOn, test } from 'bun:test'
import { audioSettings } from './settings'

test('CosyVoice 残缺模式回退 zero_shot，无效条目不影响网关及其他声音', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const settings = audioSettings.parse({
      cosyvoiceApi: 'gateway',
      cosyvoiceVoices: [
        { id: 'empty', mode: '' },
        { id: 'missing' },
        { id: 'old', mode: 'legacy' },
        { id: 'valid', name: '有效', mode: 'sft' },
        null,
        { name: '缺少标识' },
        { id: '  ' },
      ],
    })
    expect(settings.cosyvoiceApi).toBe('gateway')
    expect(settings.cosyvoiceVoices.map(({ id, mode }) => ({ id, mode }))).toEqual([
      { id: 'empty', mode: 'zero_shot' },
      { id: 'missing', mode: 'zero_shot' },
      { id: 'old', mode: 'zero_shot' },
      { id: 'valid', mode: 'sft' },
    ])
    expect(warn).toHaveBeenCalledTimes(1)
  } finally {
    warn.mockRestore()
  }
})

test('所有声音列表保留有效项，丢弃无法修复的项及非数组值', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    for (const key of ['fishVoices', 'minimaxCustomVoices', 'volcengineCustomVoices'] as const) {
      const settings = audioSettings.parse({ [key]: [null, 'bad', {}, { id: '' }, { id: 'voice', gender: 'old' }] })
      expect(settings[key]).toEqual([{ id: 'voice', name: '', gender: undefined }])
    }
    const voice = { engine: 'edge' as const, voice: 'zh-CN-XiaoxiaoNeural', speed: 1 }
    expect(audioSettings.parse({ npcVoices: [null, {}, { ...voice, voice: '' }, voice] }).npcVoices).toEqual([voice])
    const keys = [
      'cosyvoiceVoices',
      'gptsovitsVoices',
      'fishVoices',
      'minimaxCustomVoices',
      'volcengineCustomVoices',
      'npcVoices',
    ] as const
    for (const value of [null, '', {}]) {
      const settings = audioSettings.parse(Object.fromEntries(keys.map((key) => [key, value])))
      for (const key of keys) expect(settings[key]).toEqual([])
    }
  } finally {
    warn.mockRestore()
  }
})

test('GPT-SoVITS 的坏语气参考单独跳过，父声音保留且缺省字段可修复', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const settings = audioSettings.parse({
      gptsovitsVoices: [
        null,
        'bad',
        {
          name: '参考声音',
          refAudioPath: '/voice.wav',
          promptLang: '',
          textLang: null,
          emotionRefs: [
            null,
            { tone: 'old', refAudioPath: '/bad.wav' },
            { tone: 'sad' },
            { tone: 'sad', refAudioPath: '/joy.wav' },
          ],
        },
        { id: 'second', emotionRefs: 'bad' },
      ],
    })
    expect(settings.gptsovitsVoices).toHaveLength(2)
    expect(settings.gptsovitsVoices[0]).toMatchObject({
      promptLang: 'zh',
      textLang: 'auto',
      emotionRefs: [{ tone: 'sad', refAudioPath: '/joy.wav', promptText: '' }],
    })
    expect(settings.gptsovitsVoices[0]?.id).toHaveLength(16)
    expect(settings.gptsovitsVoices[1]?.emotionRefs).toEqual([])
  } finally {
    warn.mockRestore()
  }
})

test('标量字段非法时退回默认值，合法字段及旧开关迁移不受影响', () => {
  const defaults = audioSettings.parse({})
  for (const [key, value] of Object.entries(defaults)) {
    if (Array.isArray(value)) continue
    expect(audioSettings.parse({ [key]: {} })[key as keyof typeof defaults]).toEqual(value)
  }
  for (const value of ['', 'legacy', null]) {
    expect(audioSettings.parse({ cosyvoiceApi: value, deliveryMode: value })).toMatchObject({
      cosyvoiceApi: 'official',
      deliveryMode: 'basic',
    })
  }
  expect(
    audioSettings.parse({ autoBgmEvery: 0, edgeVolume: 101, cacheMaxMb: -1, cosyvoiceSampleRate: 0 }),
  ).toMatchObject({
    autoBgmEvery: 5,
    edgeVolume: 0,
    cacheMaxMb: 500,
    cosyvoiceSampleRate: 22050,
  })
  expect(audioSettings.parse({ expressionStyle: false, ttsEnabled: true })).toMatchObject({
    deliveryMode: 'off',
    ttsEnabled: true,
  })
})
