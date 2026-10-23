import { expect, test } from 'bun:test'
import { CUES, lineDeliverySchema } from '@nobot/shared'
import { normalizeDeliveryTags, parseCues, parseLineDelivery, parseStageMessage, toDisplayText } from './index'

const opts = { knownNames: ['Alice'], vars: {}, inline: false, mvu: false }

test.each([
  '<say who="Alice" expr="sadness" tone="very whispering, holding back tears">Hi<sigh /> there<LAUGH/></say>',
  'Alice[sadness|very whispering, holding back tears]：Hi<sigh /> there<LAUGH/>',
])('两种语法保留声音原文和偏移，显示时隐藏演绎：%s', (source) => {
  const beat = parseStageMessage(source, opts).stage.beats[0]
  expect(beat).toEqual({
    kind: 'line',
    speaker: 'Alice',
    expression: 'sadness',
    text: 'Hi<sigh /> there<LAUGH/>',
    delivery: { volume: 'whisper', intensity: 3, direction: 'holding back tears' },
    cues: [
      { at: 2, cue: 'sigh' },
      { at: 8, cue: 'laugh' },
    ],
  })
  expect(toDisplayText(source, { ...opts, speaker: 'bold' })).toBe('**Alice**：Hi there')
  expect(toDisplayText(source, { ...opts, speaker: 'none' })).toBe('Hi there')
  expect(toDisplayText(source, { ...opts, speaker: 'plain', streaming: true })).toBe('Alice：Hi there')
})

test('控制词大小写与单词边界、强弱和说明截断', () => {
  expect(parseLineDelivery('a little SHOUTING, in a hurry')).toEqual({
    intensity: 1,
    volume: 'shout',
    direction: 'in a hurry',
  })
  expect(parseLineDelivery('extremely yelling')).toEqual({ intensity: 3, volume: 'shout' })
  expect(parseLineDelivery('slightly whisper')).toEqual({ intensity: 1, volume: 'whisper' })
  expect(parseLineDelivery('every whisperingbird')).toEqual({ direction: 'every whisperingbird' })
  expect(parseLineDelivery('x'.repeat(130)).direction).toHaveLength(120)
})

test('没有标注时不增加字段，普通文本 cue 同样隐藏，其他尖括号保留', () => {
  expect(parseStageMessage('Alice[joy]：Hi', opts).stage.beats[0]).toEqual({
    kind: 'line',
    speaker: 'Alice',
    expression: 'joy',
    text: 'Hi',
  })
  expect(toDisplayText('a<breath/>b<unknown/>', { ...opts, speaker: 'none' })).toBe('ab')
  expect(parseCues('a<breath/>b')).toEqual({ text: 'ab', cues: [{ at: 1, cue: 'breath' }] })
})

test('HTTP 逐句覆盖不填入默认值，避免覆盖基础演绎的其余字段', () => {
  expect(lineDeliverySchema.parse({ volume: 'whisper' })).toEqual({ volume: 'whisper' })
  expect(lineDeliverySchema.parse({})).toEqual({})
})

test.each([
  ['普通。<whisper/>秘密。', '普通。秘密。'],
  ['Normal.<whisper/>Secret.', 'Normal.Secret.'],
  ['普通。<shout/>秘密。', '普通。秘密。'],
  ['Normal.<shout/>Secret.', 'Normal.Secret.'],
])('自闭合音量始终覆盖整条台词：%s', (source, text) => {
  expect(parseCues(source)).toEqual({ text, cues: [], volume: source.includes('whisper') ? 'whisper' : 'shout' })
})

test.each([
  ['普通。<whisper>秘密。</whisper>恢复。', '普通。秘密。恢复。', 3, 6],
  ['Normal.<whisper>Secret.</whisper>Back.', 'Normal.Secret.Back.', 7, 14],
])('成对作用域偏移使用纯正文，显示保留内部文字：%s', (source, text, start, end) => {
  expect(parseCues(source)).toEqual({ text, cues: [], spans: [{ start, end, volume: 'whisper' }] })
  expect(toDisplayText(`<say who="Alice">${source}</say>`, { ...opts, speaker: 'none' })).toBe(text)
})

test('只消费确切别名，括号文字、比较符、未知成对和舞台指令保留', () => {
  for (const alias of ['[whispers]', '[whispering]', '(whispering)', '[shouts]', '[shouting]', '(shouting)']) {
    expect(parseCues(`甲${alias}乙`).text).toBe('甲乙')
    expect(parseCues(`A${alias}B`).volume).toBe(alias.includes('whisp') ? 'whisper' : 'shout')
  }
  const literal =
    'a<b <3 （小声）(quietly) [aside] *whispers* <unknown>秘密</unknown> <say/> <cg/> <choices/> <combat/>'
  expect(parseCues(`${literal}<foobar/><word-word/>`).text).toBe(literal)
})

test('停顿默认、别名、整数范围及 cue 偏移', () => {
  expect(parseCues('甲<pause ms="500"/><inhale/>乙')).toEqual({
    text: '甲乙',
    cues: [{ at: 1, cue: 'inhale' }],
    pauses: [{ at: 1, ms: 500 }],
  })
  expect(parseCues('A<pause/>B[pause]C[short pause]D[long pause]E').pauses).toEqual([
    { at: 1, ms: 500 },
    { at: 2, ms: 500 },
    { at: 3, ms: 300 },
    { at: 4, ms: 1000 },
  ])
  expect(parseCues('甲<pause ms="0"/>乙<pause ms="999999999"/>丙').pauses).toEqual([
    { at: 1, ms: 1 },
    { at: 2, ms: 99990 },
  ])
})

test('中英文每种声音事件都消费且记录清理后的偏移', () => {
  for (const prefix of ['甲', 'A']) {
    for (const cue of CUES)
      expect(parseCues(`${prefix}<${cue}/>乙B`)).toEqual({ text: `${prefix}乙B`, cues: [{ at: 1, cue }] })
  }
  expect(parseCues('甲<pause ms="-1"/>乙<pause ms="oops"/>丙')).toEqual({ text: '甲乙丙', cues: [] })
})

test('真实台词保留正文、声音位置和尖叫范围，显示层隐藏标签', () => {
  const mage = '红袍魔导士：「<screaming>怎么回事？！</screaming><gasp>底舱进水了！龙骨断了！！</gasp>」'
  const hunter = '灰绿猎装女子：「<chuckle>看来你们这只『游隼』今晚是飞不出博德之门了。</chuckle>」'
  expect(parseCues(mage)).toEqual({
    text: '红袍魔导士：「怎么回事？！底舱进水了！龙骨断了！！」',
    cues: [{ at: 13, cue: 'gasp' }],
    spans: [{ start: 7, end: 13, volume: 'shout' }],
  })
  expect(parseCues(hunter)).toEqual({
    text: '灰绿猎装女子：「看来你们这只『游隼』今晚是飞不出博德之门了。」',
    cues: [{ at: 8, cue: 'chuckle' }],
  })
  expect(toDisplayText(mage, { ...opts, speaker: 'plain' })).toBe(parseCues(mage).text)
  expect(toDisplayText(hunter, { ...opts, speaker: 'plain' })).toBe(parseCues(hunter).text)
})

test('每种声音的成对、未闭合和孤立结束标签都不泄漏', () => {
  for (const cue of CUES) {
    expect(parseCues(`甲<${cue}>乙</${cue}>丙`)).toEqual({ text: '甲乙丙', cues: [{ at: 1, cue }] })
    expect(parseCues(`甲<${cue}>乙`)).toEqual({ text: '甲乙', cues: [{ at: 1, cue }] })
    expect(parseCues(`甲</${cue}>乙`)).toEqual({ text: '甲乙', cues: [] })
  }
})

test.each([
  ['laughs laughing', 'laugh'],
  ['chuckles chuckling giggle giggles giggling', 'chuckle'],
  ['sighs sighing', 'sigh'],
  ['gasps gasping', 'gasp'],
  ['breathes breathing', 'breath'],
  ['sobs sobbing', 'sob'],
  ['coughs coughing', 'cough'],
  ['inhales', 'inhale'],
  ['exhales', 'exhale'],
  ['pants panting', 'pant'],
  ['groans groaning', 'groan'],
  ['yawns yawning', 'yawn'],
  ['sniffs sniffing sniffles', 'sniff'],
  ['sneezes sneezing', 'sneeze'],
] as const)('声音别名的自闭合、成对和未闭合形式：%s', (aliases, cue) => {
  for (const alias of aliases.split(' ')) {
    expect(parseCues(`甲<${alias}/>乙<${alias}>丙</${alias}>丁<${alias}>戊`)).toEqual({
      text: '甲乙丙丁戊',
      cues: [
        { at: 1, cue },
        { at: 2, cue },
        { at: 4, cue },
      ],
    })
    expect(parseCues(`甲</${alias}>乙`)).toEqual({ text: '甲乙', cues: [] })
  }
})

test.each(['screaming', 'yelling', 'shouting', 'scream', 'yell', 'whispering'])(
  '音量别名成对生成范围，自闭合覆盖整句：%s',
  (alias) => {
    const volume = alias === 'whispering' ? 'whisper' : 'shout'
    expect(parseCues(`甲<${alias}>乙</${alias}>丙`)).toEqual({
      text: '甲乙丙',
      cues: [],
      spans: [{ start: 1, end: 2, volume }],
    })
    expect(parseCues(`甲<${alias}/>乙`)).toEqual({ text: '甲乙', cues: [], volume })
    expect(parseCues(`甲<${alias}>乙`)).toEqual({
      text: '甲乙',
      cues: [],
      spans: [{ start: 1, end: 2, volume }],
    })
  },
)

test('未知成对标签、HTML、舞台指令和非标签正文保留，未知自闭合清理', () => {
  expect(parseCues('甲<trembling>乙<voice-break/>丙</trembling><constructor>丁</constructor>')).toEqual({
    text: '甲<trembling>乙丙</trembling><constructor>丁</constructor>',
    cues: [],
  })
  for (const name of 'b i u s em strong small mark del ins sub sup code pre br p span div q blockquote ruby rt rp details summary font center hr a img ul ol li table tr td th thead tbody scene show hide expr say state choices cg sfx updatevariable combat bgm'.split(
    ' ',
  )) {
    const source = `<${name}>甲</${name}><${name}/>`
    expect(parseCues(source)).toEqual({ text: source, cues: [] })
  }
  const source =
    'a < b <Name>甲</Name><UNKNOWN/> <unknown kind="x">乙</unknown kind="x"> <gasp kind="x"> <scene bg="night" />'
  expect(parseCues(source)).toEqual({ text: source, cues: [] })
})

test.each([
  [
    '红袍魔导士：「<screaming>怎么回事？！</screaming><gasp>底舱进水了！龙骨断了！！</gasp>」',
    '红袍魔导士：「<shout>怎么回事？！</shout><gasp/>底舱进水了！龙骨断了！！」',
  ],
  [
    '灰绿猎装女子：「<chuckle>看来你们这只『游隼』今晚是飞不出博德之门了。</chuckle>」',
    '灰绿猎装女子：「<chuckle/>看来你们这只『游隼』今晚是飞不出博德之门了。」',
  ],
  ['甲<laughs/>乙<laughing>丙</laughing><sighing >丁', '甲<laugh/>乙<laugh/>丙<sigh/>丁'],
  ['<GASP>甲</GASP><LAUGHS />', '<gasp/>甲<laugh/>'],
  ['<foobar/><word-word/><UNKNOWN/><constructor/>', '<UNKNOWN/>'],
  ['<pause ms="-1"/><pause ms="oops"/><pause extra="x"/><pause></pause>', ''],
])('历史标签原位规范化：%s', (source, expected) => {
  expect(normalizeDeliveryTags(source)).toBe(expected)
})

test('所有规范声音标签保持原样，开头与结束形式规范化', () => {
  for (const cue of CUES) {
    expect(normalizeDeliveryTags(`<${cue}/> <${cue} />`)).toBe(`<${cue}/> <${cue} />`)
    expect(normalizeDeliveryTags(`<${cue}>甲</${cue}><${cue} >乙`)).toBe(`<${cue}/>甲<${cue}/>乙`)
  }
})

test('音量别名成对规范化，自闭合与括号音量删除', () => {
  for (const name of ['whisper', 'whispering', 'shout', 'shouting', 'screaming', 'yelling', 'scream', 'yell']) {
    const volume = name.startsWith('whisp') ? 'whisper' : 'shout'
    expect(normalizeDeliveryTags(`甲<${name}>乙</${name}>丙`)).toBe(`甲<${volume}>乙</${volume}>丙`)
    expect(normalizeDeliveryTags(`甲<${name}/>乙<${name} />丙`)).toBe('甲乙丙')
  }
  expect(normalizeDeliveryTags('甲[whispers][whispering](whispering)[shouts][shouting](shouting)乙')).toBe('甲乙')
})

test('正文、空白、未知成对标签、HTML、舞台指令、属性和有效停顿逐字保留', () => {
  const source =
    '  a < b <Name>甲</Name><unknown>x</unknown><b><br/> <scene bg="x"/> <say who=甲>\n' +
    '<gasp kind="x">乙</gasp kind="x"><laughs kind="x"/><whispering kind="x"> <unknown kind="x"/>\t' +
    '<shout >丙</shout ><whisper>丁</whisper><pause/><pause ms="0"/><pause ms="999999999" />' +
    '[pause][short pause][long pause] （小声）(quietly) [aside] *whispers*'
  expect(normalizeDeliveryTags(source)).toBe(source)
})

test('畸形输入组合保持解析正文、声音偏移和音量范围，且规范化幂等', () => {
  const tokens = [
    ...CUES.flatMap((cue) => [`<${cue}>`, `</${cue}>`, `<${cue}/>`]),
    ...'laughs laughing chuckles chuckling giggle giggles giggling sighs sighing gasps gasping breathes breathing sobs sobbing coughs coughing inhales exhales pants panting groans groaning yawns yawning sniffs sniffing sniffles sneezes sneezing'
      .split(' ')
      .flatMap((alias) => [`<${alias}>甲</${alias}>`, `<${alias}/>`, `<${alias} >`]),
    ...'whisper whispering shout shouting screaming yelling scream yell'
      .split(' ')
      .flatMap((alias) => [`<${alias}>甲</${alias}>`, `<${alias}/>`, `<${alias}>`, `</${alias}>`]),
    '[whispers]',
    '[whispering]',
    '[shouts]',
    '[shouting]',
    '(whispering)',
    '(shouting)',
    '<foobar/>',
    '<word-word/>',
    '<pause ms="oops"/>',
    '<pause ms="25"/>',
    '[short pause]',
    '<unknown>甲</unknown>',
    '<scene bg="x"/>',
    '<gasp kind="x">',
    '<UNKNOWN/>',
  ]
  for (const first of tokens) {
    for (const second of tokens) {
      const source = `甲A${first}乙B${second}丙C`
      const normalized = normalizeDeliveryTags(source)
      const before = parseCues(source)
      const after = parseCues(normalized)
      // 禁用的整句音量形式会被删除，因此只比较应保持的正文、事件和范围。
      expect({ text: after.text, cues: after.cues, spans: after.spans, pauses: after.pauses }).toEqual({
        text: before.text,
        cues: before.cues,
        spans: before.spans,
        pauses: before.pauses,
      })
      expect(normalizeDeliveryTags(normalized)).toBe(normalized)
    }
  }
})
