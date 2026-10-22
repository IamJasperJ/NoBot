import { describe, expect, test } from 'bun:test'
import { CUES, type Delivery, type DeliveryCapabilities, type DeliveryFormat } from '@nobot/shared'
import { deliveryFromExpression, parseCues, renderDelivery, sanitizeForEngine, toneInstruction } from './delivery'

const delivery: Delivery = { tone: 'happy', intensity: 3, volume: 'whisper', direction: 'holding back tears' }
const capabilities = (format: DeliveryFormat): DeliveryCapabilities => ({
  format,
  emotion: format === 'cosyvoice' ? 'instruction' : 'tags-free',
  intensity: true,
  direction: true,
  volume: true,
  cues: [...CUES],
})

test('解析全部声音标记，保留其他尖括号及连续标记的字符偏移', () => {
  expect(parseCues('你<Laugh />好<sigh/><GASP/>！<other/>')).toEqual({
    text: '你好！',
    cues: [
      { at: 1, cue: 'laugh' },
      { at: 2, cue: 'sigh' },
      { at: 2, cue: 'gasp' },
    ],
  })
  expect(parseCues(CUES.map((cue) => `<${cue}/>`).join('')).cues).toEqual(CUES.map((cue) => ({ at: 0, cue })))
  expect(parseCues('😀<sob/>')).toEqual({ text: '😀', cues: [{ at: 2, cue: 'sob' }] })
})

describe('各引擎翻译表', () => {
  const cases: { format: DeliveryFormat; text: string; params: object }[] = [
    { format: 'openai', text: '你好', params: { instructions: expect.stringContaining('very happy') } },
    { format: 'eleven-tags', text: '[very happy] [whispers] [holding back tears] 你[laughs]好', params: {} },
    { format: 'eleven-settings', text: '你好', params: { voiceSettings: { style: 0.7, stability: 0.3 } } },
    { format: 'fish-s2', text: '[very happy tone] [whispering] [holding back tears] 你[laughing]好', params: {} },
    { format: 'fish-s1', text: '(happy) (whispering) 你(laughing)好', params: {} },
    { format: 'minimax', text: '你(laughs)好', params: { emotion: 'whisper' } },
    {
      format: 'volcengine',
      text: '你好',
      params: {
        emotion: 'happy',
        emotionScale: 5,
        contextTexts: ['Speak in a very happy tone. Whisper. holding back tears'],
      },
    },
    { format: 'cosyvoice', text: '你[laughter]好', params: { instructions: expect.stringContaining('Whisper.') } },
    { format: 'gptsovits', text: '你好', params: { tone: 'happy' } },
    { format: 'prosody', text: '你好', params: { prosody: { rate: 1.06, pitch: 1.045, volume: 0.6 } } },
    { format: 'none', text: '你好', params: {} },
  ]
  for (const { format, text, params } of cases)
    test(format, () => {
      const result = renderDelivery(capabilities(format), delivery, parseCues('你<laugh/>好'))
      expect(result.text).toBe(text)
      expect(result.params).toMatchObject(params)
      expect(result.text).not.toContain('<laugh')
    })
})

test('先清理原文，再插标签，插入点跨方括号也正确', () => {
  for (const format of ['eleven-tags', 'fish-s2', 'cosyvoice'] as const) {
    expect(sanitizeForEngine('[shouting] hello', capabilities(format))).toBe(' hello')
    const rendered = renderDelivery(capabilities(format), undefined, parseCues('[a<laugh/>b]'))
    expect(rendered.text).toBe(
      format === 'eleven-tags' ? '【a[laughs]b】' : format === 'fish-s2' ? '【a[laughing]b】' : '【a[laughter]b】',
    )
  }
  for (const format of ['fish-s1', 'minimax'] as const)
    expect(sanitizeForEngine('(clear-throat)(happy)(a word)（中文）(中文)', capabilities(format))).toBe(
      '（clear-throat）（happy）（a word）（中文）(中文)',
    )
})

test('仅允许能力表支持的声音，弱模型不会残留标签', () => {
  for (const format of ['none', 'openai', 'eleven-settings', 'minimax', 'cosyvoice'] as const) {
    const caps = { ...capabilities(format), cues: [], volume: false, direction: false }
    expect(renderDelivery(caps, undefined, parseCues('a<laugh/><sob/><cough/>b')).text).toBe('ab')
  }
  expect(renderDelivery(capabilities('fish-s1'), { ...delivery, tone: 'disgusted' }, parseCues('hi')).text).toContain(
    '(disgusted)',
  )
  expect(
    renderDelivery(capabilities('eleven-settings'), { ...delivery, tone: 'calm' }, parseCues('hi')).params,
  ).toEqual({})
})

test('强度、韵律及旧指令调用兼容', () => {
  expect(toneInstruction('happy')).toBe('Speak in a happy tone.')
  expect(toneInstruction('sad', 1, 'shout', 'slowly', 'gentle')).toBe(
    'Speak in a slightly sad tone. Shout. slowly gentle',
  )
  expect(deliveryFromExpression('grief')).toEqual({ tone: 'sad', intensity: 2, volume: 'normal', direction: '' })
  for (const intensity of [1, 2, 3] as const) {
    const result = renderDelivery(
      capabilities('prosody'),
      { ...delivery, tone: 'sad', volume: 'normal', intensity },
      parseCues('hi'),
    )
    expect(result.params.prosody?.rate).toBeCloseTo(1 - (0.08 * intensity) / 2)
    expect(result.params.prosody?.pitch).toBeCloseTo(1 - (0.04 * intensity) / 2)
    expect(
      renderDelivery(capabilities('volcengine'), { ...delivery, intensity }, parseCues('hi')).params.emotionScale,
    ).toBe([2, 4, 5][intensity - 1])
  }
  const openai = renderDelivery(capabilities('openai'), undefined, parseCues('a<sigh/>b'))
  expect(openai.params.instructions).toContain('sigh')
  expect(openai.text).toBe('ab')
})

test('角色默认风格只合入支持说明的引擎，自由标签在 direction 缺省时使用', () => {
  const line = { text: 'Hello', cues: [] }
  const delivery = { tone: 'neutral' as const, intensity: 2 as const, volume: 'normal' as const, direction: '' }
  const style = 'Warm and measured.'
  for (const format of ['openai', 'cosyvoice', 'volcengine', 'eleven-tags', 'fish-s2'] as const) {
    const caps = { format, emotion: 'instruction' as const, intensity: true, direction: true, volume: true, cues: [] }
    const rendered = renderDelivery(caps, delivery, line, style)
    expect(JSON.stringify(rendered)).toContain(style)
    const directed = renderDelivery(caps, { ...delivery, direction: 'holding back tears' }, line, style)
    expect(JSON.stringify(directed)).toContain('holding back tears')
    if (format === 'eleven-tags' || format === 'fish-s2') expect(JSON.stringify(directed)).not.toContain(style)
  }
  const caps = {
    format: 'none' as const,
    emotion: 'none' as const,
    intensity: false,
    direction: false,
    volume: false,
    cues: [],
  }
  expect(renderDelivery(caps, delivery, line, style)).toEqual({ text: 'Hello', params: {} })
})

test('span 严格过半才退化整句，重叠不重复计数，兼容音量优先', () => {
  const caps = capabilities('prosody')
  expect(renderDelivery(caps, undefined, parseCues('a<whisper>bc</whisper>')).params.prosody?.volume).toBe(0.6)
  expect(renderDelivery(caps, undefined, parseCues('ab<whisper>cd</whisper>')).params).toEqual({})
  expect(renderDelivery(caps, undefined, parseCues('abc<whisper><whisper>d</whisper></whisper>')).params).toEqual({})
  expect(renderDelivery(caps, undefined, parseCues('<shout/>a<whisper>bc</whisper>')).params.prosody?.volume).toBe(1.25)
})

test('逐协议停顿上限、语义停顿及不支持时去除', () => {
  const line = parseCues('A<pause ms="500"/>B<pause ms="10000"/>C')
  for (const [format, text] of [
    ['eleven-settings', 'A<break time="0.5s"/>B<break time="3s"/>C'],
    ['eleven-tags', 'A[short pause]B[long pause]C'],
    ['fish-s1', 'A(break)B(long-break)C'],
    ['fish-s2', 'A[break]B[long-break]C'],
    ['minimax', 'A<#0.5#>B<#10#>C'],
    ['openai', 'ABC'],
    ['cosyvoice', 'ABC'],
    ['volcengine', 'ABC'],
    ['gptsovits', 'ABC'],
    ['prosody', 'ABC'],
    ['none', 'ABC'],
  ] as const)
    expect(renderDelivery(capabilities(format), undefined, line).text).toBe(text)
  expect(
    renderDelivery(capabilities('minimax'), undefined, parseCues('<pause/>A<pause/><pause/> <pause/>B<pause/>')).text,
  ).toBe('A<#0.5#> B')
})

test('每个声音事件按显式词表转换，sniff 与 sob 分开', () => {
  const line = parseCues(`A${CUES.map((cue) => `<${cue}/>`).join('')}B`)
  expect(line.cues).toEqual(CUES.map((cue) => ({ at: 1, cue })))
  expect(renderDelivery(capabilities('minimax'), undefined, line).text).toBe(
    'A(laughs)(chuckle)(sighs)(gasps)(breath)(coughs)(clear-throat)(inhale)(exhale)(pant)(groans)(sniffs)(sneezes)B',
  )
  expect(renderDelivery(capabilities('fish-s1'), undefined, line).text).toBe(
    'A(laughing)(chuckling)(sighing)(gasping)(sobbing)(panting)(groaning)(yawning)B',
  )
  expect(renderDelivery(capabilities('fish-s2'), undefined, line).text).toBe(
    'A[laughing][chuckling][sighing][gasping][sobbing][clear throat][panting][groaning][yawning]B',
  )
  expect(renderDelivery(capabilities('cosyvoice'), undefined, line).text).toBe(
    'A[laughter][sigh][quick_breath][breath][cough]B',
  )
  expect(renderDelivery({ ...capabilities('none'), cues: [] }, undefined, line)).toEqual({ text: 'AB', params: {} })
})

test('直接传入原文也先解析，控制词不被全角转换后朗读', () => {
  for (const format of [
    'none',
    'prosody',
    'openai',
    'eleven-tags',
    'eleven-settings',
    'fish-s1',
    'fish-s2',
    'cosyvoice',
    'gptsovits',
    'minimax',
    'volcengine',
  ] as const) {
    const raw = 'A[whispering]<pause/>B<foobar/>(shouting)'
    expect(sanitizeForEngine(raw, capabilities(format))).toBe('AB')
    expect(renderDelivery(capabilities(format), undefined, { text: raw, cues: [] }).text).not.toContain('foobar')
  }
})

test('豆包 2.0 所有演绎字段合并到第一条英文指令', () => {
  expect(
    renderDelivery(capabilities('volcengine'), delivery, parseCues('你好'), 'Warm and measured.').params.contextTexts,
  ).toEqual(['Speak in a very happy tone. Whisper. holding back tears Warm and measured.'])
})
