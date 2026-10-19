import { describe, expect, test } from 'bun:test'
import type { CastMember, StageOp, StagePosition, StageState } from '@nobot/shared'
import {
  applyStageOps,
  autoPosition,
  castKey,
  emptyStage,
  foldStage,
  type InstructionsInput,
  mergeStateSchemas,
  type ParseOptions,
  parseInitVars,
  parseStageMessage,
  parseStateSchema,
  renderDirectiveInstructions,
  schemaInitVars,
  stateStageName,
  toDisplayText,
} from './index'

const defaults: ParseOptions = {
  knownNames: ['艾莉丝', 'Adolion Storyteller'],
  narratorNames: ['旁白', 'GM'],
  vars: {},
  inline: true,
  mvu: true,
}
const parse = (content: string, opts: Partial<ParseOptions> = {}) =>
  parseStageMessage(content, { ...defaults, ...opts })
const display = (content: string, speaker: 'bold' | 'plain' | 'none' = 'plain', streaming = false) =>
  toDisplayText(content, { ...defaults, speaker, streaming })

describe('台词与拍', () => {
  const specialName = '[D&D] Forgotten Realms: Sword Coast'

  test.each(['', '[neutral]'])('已知特殊长名字保留原文并贯通显示、台词拍和舞台操作：%s', (suffix) => {
    const speaker = '[d&d] Forgotten Realms: SWORD Coast'
    const source = `  ${speaker}${suffix} ： 「欢迎」`
    const opts = { ...defaults, knownNames: [specialName] }
    const { stage } = parseStageMessage(source, opts)
    expect(stage.beats).toEqual([
      { kind: 'line', speaker, text: '「欢迎」', ...(suffix ? { expression: 'neutral' } : {}) },
    ])
    expect(stage.ops).toEqual([
      suffix ? { op: 'expr', who: speaker, expression: 'neutral' } : { op: 'show', who: speaker },
    ])
    for (const mode of ['plain', 'bold', 'none'] as const) {
      expect(toDisplayText(source, { ...opts, speaker: mode })).toBe(
        mode === 'none' ? '「欢迎」' : `${mode === 'bold' ? `**${speaker}**` : speaker}：「欢迎」`,
      )
    }
    const initial = applyStageOps(emptyStage(), [{ op: 'show', who: specialName, at: 'right' }])
    expect(applyStageOps(initial, stage.ops).cast).toEqual([
      { key: castKey(specialName), name: speaker, at: 'right', expression: suffix ? 'neutral' : '' },
    ])
  })

  test.each(['', '[neutral]'])('未知特殊长名字仍为旁白：%s', (suffix) => {
    const source = `${specialName}${suffix}：「欢迎」`
    expect(parse(source).stage.beats).toEqual([{ kind: 'narration', text: source }])
    expect(parse(source).stage.ops).toEqual([])
    expect(display(source)).toBe(source)
  })

  test('已知名字优先匹配最长前缀，名字后的非分隔文本不算匹配', () => {
    const opts = { knownNames: ['Alice', 'Alice[DM]', 'Alice: DM'] }
    for (const speaker of ['Alice[DM]', 'Alice: DM']) {
      expect(parse(`${speaker}: hello`, opts).stage.beats).toEqual([{ kind: 'line', speaker, text: 'hello' }])
    }
    expect(parse('Alice explains: hello', opts).stage.beats).toEqual([
      { kind: 'narration', text: 'Alice explains: hello' },
    ])
  })

  test('特殊长旁白名字无需列入角色集合，也不产生舞台操作', () => {
    const source = `${specialName}[neutral]: 风吹过。`
    const opts = { ...defaults, narratorNames: [specialName.toUpperCase()] }
    const { stage } = parseStageMessage(source, opts)
    expect(stage.beats).toEqual([{ kind: 'narration', text: '风吹过。' }])
    expect(stage.ops).toEqual([])
    expect(toDisplayText(source, { ...opts, speaker: 'plain' })).toBe('风吹过。')
  })

  test('XML say 和显式表情操作支持特殊长名字', () => {
    const opts = { ...defaults, knownNames: [specialName] }
    const source = `<say who="${specialName}" expr="neutral">「欢迎」</say>`
    const { stage } = parseStageMessage(source, opts)
    expect(stage).toEqual(parseStageMessage(`${specialName}[neutral]：「欢迎」`, opts).stage)
    expect(toDisplayText(source, { ...opts, speaker: 'plain' })).toBe(`${specialName}：「欢迎」`)
    const ops = parse(`<show who="${specialName}"/><expr who="${specialName}" v="joy"/>`).stage.ops
    expect(ops).toEqual([
      { op: 'show', who: specialName },
      { op: 'expr', who: specialName, expression: 'joy' },
    ])
    expect(applyStageOps(emptyStage(), ops).cast).toEqual([
      { key: castKey(specialName), name: specialName, at: 'center', expression: 'joy' },
    ])
  })

  test.each([
    ['艾莉丝：你好', '艾莉丝', '你好', undefined],
    ['陌生人[joy]: 你好', '陌生人', '你好', 'joy'],
    ['陌生人：「你好」', '陌生人', '「你好」', undefined],
    ['陌生人: 『你好』', '陌生人', '『你好』', undefined],
    ['陌生人：“你好”', '陌生人', '“你好”', undefined],
    ['陌生人: "你好"', '陌生人', '"你好"', undefined],
    [' adolion storyteller : 欢迎', 'adolion storyteller', '欢迎', undefined],
  ])('三种认定条件与名字：%s', (source, speaker, text, expression) => {
    const result = parse(source!)
    expect(result.stage.beats).toEqual([{ kind: 'line', speaker, text, ...(expression ? { expression } : {}) }])
    expect(result.stage.ops).toEqual([
      expression ? { op: 'expr', who: speaker, expression } : { op: 'show', who: speaker },
    ])
  })

  test.each(['注意：xxx', '*动作*：说明', '「名字」：「台词」', `${'x'.repeat(25)}：「长名字」`, '甲[坏]乙：说明'])(
    '普通行不误认：%s',
    (source) => {
      expect(parse(source).stage.beats).toEqual([{ kind: 'narration', text: source }])
      expect(display(source)).toBe(source)
    },
  )

  test('旁白名字不需要其他认定条件，也不产生上台操作', () => {
    const result = parse('旁白：风吹过。\nGM[joy]：天黑了。')
    expect(result.stage.beats).toEqual([
      { kind: 'narration', text: '风吹过。' },
      { kind: 'narration', text: '天黑了。' },
    ])
    expect(result.stage.ops).toEqual([])
    expect(display('旁白：风吹过。')).toBe('风吹过。')
  })

  test('say 与速记等价，旁白 say 同样去掉说话人', () => {
    expect(parse('<SAY WHO="艾莉丝" EXPR=joy>「欢迎」</SAY>')).toEqual(parse('艾莉丝[joy]：「欢迎」'))
    expect(parse('<say who=旁白>天黑了。</say>')).toEqual(parse('旁白：天黑了。'))
    expect(display('<say who=艾莉丝>欢迎</say>', 'bold')).toBe('**艾莉丝**：欢迎')
  })

  test('连续操作合并，文本和其他拍形成边界', () => {
    const result = parse(
      '<scene bg=夜/>\n<show who=甲/>\n<expr who=甲 v=joy/>\n旁白\n<hide who=甲/>\n<cg prompt="星空"/><sfx name=雷/>',
    )
    expect(result.stage.beats.map((beat) => beat.kind)).toEqual(['stage', 'narration', 'stage', 'cg', 'sfx'])
    expect(result.stage.beats[0]).toEqual({ kind: 'stage', ops: result.stage.ops.slice(0, 3) })
    expect(result.stage.beats.slice(-2)).toEqual([
      { kind: 'cg', prompt: '星空' },
      { kind: 'sfx', name: '雷' },
    ])
  })

  test('长旁白在长度内最后一个句末标点后切分，无标点硬切，按 Unicode 字符计数', () => {
    expect(parse('甲。乙！丙丁戊己？庚辛', { narrationSplit: 5 }).stage.beats).toEqual([
      { kind: 'narration', text: '甲。乙！' },
      { kind: 'narration', text: '丙丁戊己？' },
      { kind: 'narration', text: '庚辛' },
    ])
    expect(parse('😀😀😀😀😀\n甲乙丙丁戊己', { narrationSplit: 3 }).stage.beats).toEqual([
      { kind: 'narration', text: '😀😀😀' },
      { kind: 'narration', text: '😀😀' },
      { kind: 'narration', text: '甲乙丙' },
      { kind: 'narration', text: '丁戊己' },
    ])
    expect(parse('甲'.repeat(121)).stage.beats.map((beat) => ('text' in beat ? beat.text.length : 0))).toEqual([120, 1])
  })

  test('未知表情只警告，缺少必要属性的标签不产生操作', () => {
    expect(parse('艾莉丝[custom]：你好', { expressions: ['joy'] }).stage.warnings).toEqual(['未知表情：custom'])
    expect(parse('<show/><hide/><expr who=甲/>').stage.ops).toEqual([])
  })
})

describe('XML', () => {
  test('三种属性引号、大小写、成对写法、行内嵌入和未提供字段', () => {
    const result = parse(
      '前<SCENE BG="夜 > 空" BGM=夜曲 place=城 time=晚></SCENE><show who=甲 at=LEFT outfit=礼服 expr=joy></show>后<expr who=甲 expr=sadness/><hide who=甲/>',
    )
    expect(result.stage.ops).toEqual([
      { op: 'scene', bg: '夜 > 空', bgm: '夜曲', place: '城', time: '晚' },
      { op: 'show', who: '甲', at: 'left', outfit: '礼服', expression: 'joy' },
      { op: 'expr', who: '甲', expression: 'sadness' },
      { op: 'hide', who: '甲' },
    ])
    expect(parse("<scene bg='白昼'/>").stage.ops).toEqual([{ op: 'scene', bg: '白昼' }])
    expect(result.stage.beats.filter((beat) => beat.kind === 'narration')).toEqual([
      { kind: 'narration', text: '前' },
      { kind: 'narration', text: '后' },
    ])
    expect(display('前<show who=甲/>后')).toBe('前后')
  })

  test.each([1, 2, 3, 4, 5])('数字站位 %s', (at) => {
    expect(parse(`<show who=甲 at=${at}/>`).stage.ops).toEqual([{ op: 'show', who: '甲', at }])
  })

  test('未加引号的属性保留内部斜杠，三点站位都能解析', () => {
    expect(parse('<scene bg=forest/day/><show who=甲 at=center/><show who=乙 at=right/>').stage.ops).toEqual([
      { op: 'scene', bg: 'forest/day' },
      { op: 'show', who: '甲', at: 'center' },
      { op: 'show', who: '乙', at: 'right' },
    ])
  })

  test('非法站位忽略，未知 HTML 原样保留，预留指令只隐藏', () => {
    const source = '<br><b>原样</b><custom x="a">正文</custom>'
    expect(display(source)).toBe(source)
    expect(parse(source).stage.beats).toEqual([{ kind: 'narration', text: source }])
    expect(parse('<show who=甲 at=6/>').stage.ops).toEqual([{ op: 'show', who: '甲' }])
    expect(display('前<combat>秘密</combat><bgm name=音乐/>后')).toBe('前后')
    expect(display('前<bgm name=音乐>中<combat mode=战斗>后')).toBe('前中后')
  })
})

describe('变量', () => {
  test('state 的所有语句、注释、相同路径累积且不修改原变量', () => {
    const vars = { n: 5, list: ['甲', '甲', '乙'], removed: 1 }
    const result = parse(
      `<state>
// 注释
n += 3 // 原因
n -= 2
text = 原样文本
single = '单引号'
quote = 「中文」
smart = “引号”
json = {"a": [true, null]}
url = "https://test//path" // 注释
list remove "甲"
list push "丙"
new push 1
missing += 2
str = 字符串
str -= 3
delete removed
</state>`,
      { vars },
    )
    expect(result.varsPatch).toEqual({
      n: 6,
      text: '原样文本',
      single: '单引号',
      quote: '中文',
      smart: '引号',
      json: { a: [true, null] },
      url: 'https://test//path',
      list: ['甲', '乙', '丙'],
      new: [1],
      missing: 2,
      str: -3,
      removed: null,
    })
    expect(vars).toEqual({ n: 5, list: ['甲', '甲', '乙'], removed: 1 })
    expect(result.stage.beats).toEqual([])
  })

  test('删除第一个结构相等的元素，非列表先当空列表，错误语句不污染 patch', () => {
    const result = parse('<state>list remove {"a":1}\nother remove 1\nbad += xyz\n无法解析</state>', {
      vars: { list: [{ a: 1 }, { a: 1 }] },
    })
    expect(result.varsPatch).toEqual({ list: [{ a: 1 }], other: [] })
    expect(result.stage.warnings).toHaveLength(2)
  })

  test('inline 和 mvu 关闭后仍隐藏但无 patch，空块无 patch', () => {
    const source = '<state>x = 1</state><UpdateVariable>_.set("x",2);</UpdateVariable>\n_.add("x",3);'
    expect(parse(source, { inline: false, mvu: false }).varsPatch).toBeNull()
    expect(display(source)).toBe('')
    expect(parse('<state>// 注释\n</state>').varsPatch).toBeNull()
  })

  test('MVU 两参数和三参数 set、add、单引号数组对象、转义与注释', () => {
    const result = parse(`<UpdateVariable>
<Analysis>_.set('ignored', 99);</Analysis>
_.set('x', 0, 3);//原因
_.add('x', 2);
_.set('list', ['a,b', 'it\\'s', {key: true, n: null,},]);
_.set('escape', '\\n\\u4f60\\x21');
_.set('nested', { /*说明*/ unquoted: [1, 2,], });
</UpdateVariable>
_.set('x', 8); _.add('x', -1);
<state>x += 2</state>
_.add('x', 3);`)
    expect(result.varsPatch).toEqual({
      x: 12,
      list: ['a,b', "it's", { key: true, n: null }],
      escape: '\n你!',
      nested: { unquoted: [1, 2] },
    })
    expect(result.stage.beats).toEqual([])
  })

  test('MVU 字符串中的标签原样作为值，分析块和其他说明标签中的语句被忽略', () => {
    const result = parse(`<UpdateVariable>
<Analysis>_.set('错误', 1);</Analysis>
<Note>_.set('错误', 2);</Note>
_.set('html', '<b>文字</b>');
_.set('n', -1.25e2);
_.add('n', .5);
_.set('flag', false);
</UpdateVariable>`)
    expect(result.varsPatch).toEqual({ html: '<b>文字</b>', n: -124.5, flag: false })
  })

  test('错误 MVU 不执行代码，注释内语句不执行；补丁键保持扁平', () => {
    expect(
      parse("_.set('x', alert(1));\n_.set('艾莉丝.好感', 1);\n// _.set('ignored', 1);\n/* _.add('ignored', 1); */")
        .varsPatch,
    ).toEqual({ '艾莉丝.好感': 1 })
    const result = parse("_.set('__proto__', {polluted: true});")
    expect(Object.hasOwn(result.varsPatch!, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(result.varsPatch!)).toBe(Object.prototype)
  })
})

describe('选项和显示', () => {
  test('所有选项前缀、两种检定括号与最后一个块', () => {
    const result = parse(
      '<choices>\n- 旧选项\n</choices>\n<choices>\n- [察觉 DC12] 观察\n* 【 潜行 dc 15】潜入\n• 等待\n1. 前进\n2、返回\n说明\n</choices>',
    )
    expect(result.stage.choices).toEqual([
      { text: '观察', check: { skill: '察觉', dc: 12 } },
      { text: '潜入', check: { skill: '潜行', dc: 15 } },
      { text: '等待' },
      { text: '前进' },
      { text: '返回' },
    ])
    expect(result.stage.beats.filter((beat) => beat.kind === 'choices')).toHaveLength(2)
  })

  test.each(['bold', 'plain', 'none'] as const)('说话人显示方式 %s', (speaker) => {
    const expected = speaker === 'bold' ? '**艾莉丝**：「你好」' : speaker === 'plain' ? '艾莉丝：「你好」' : '「你好」'
    expect(display('艾莉丝[joy]：「你好」', speaker)).toBe(expected)
    expect(display('<say who=艾莉丝 expr=joy>「你好」</say>', speaker)).toBe(expected)
  })

  test('隐藏指令后合并空行，普通 Markdown 和引号原样保留，MVU 整行隐藏', () => {
    expect(
      display(
        '  \n*动作*  **原样** 「引号」\n\n<scene bg=夜/>\n\n\n<state>x = 1</state>\n\n旁白\n前缀 _.set("x", 1); // 原因\n末尾  ',
      ),
    ).toBe('*动作*  **原样** 「引号」\n\n旁白\n\n末尾')
  })

  test.each(['<state>\nx = ', '<choices>\n- 未完成', '<UpdateVariable>_.set(', '<sce'])(
    '流式隐藏未完成块和标签：%s',
    (tail) => {
      expect(display(`正文\n${tail}`, 'plain', true)).toBe('正文')
    },
  )

  test('流式 say 例外，闭合前已写出的台词可见；非流式未闭合变量块隐藏', () => {
    expect(display('前文\n<say who=艾莉丝 expr=joy>已经写出<sce', 'bold', true)).toBe('前文\n**艾莉丝**：已经写出')
    expect(display('正文<state>x = 1')).toBe('正文')
    expect(display('<unknown>正常</unknown>', 'plain', true)).toBe('<unknown>正常</unknown>')
  })
})

const member = (at: StagePosition, name = String(at)): CastMember => ({ key: castKey(name), name, expression: '', at })

describe('舞台折叠', () => {
  test('规范化演员标识', () => expect(castKey(' Adolion  Storyteller\t')).toBe('adolionstoryteller'))

  test.each([
    [[], 'center'],
    [['center'], 'left'],
    [['left'], 'right'],
    [['left', 'right'], 'center'],
    [['left', 'right', 'center'], 1],
    [['left', 'right', 'center', 1, 3], 2],
    [['left', 'right', 'center', 1, 2, 3, 4], 5],
    [['left', 'right', 'center', 1, 2, 3, 4, 5], 'center'],
    [[1, 2, 3, 4, 5], 'left'],
  ] as [StagePosition[], StagePosition][])('自动站位 %j → %s', (occupied, expected) => {
    expect(autoPosition(occupied.map((at) => member(at)))).toBe(expected)
  })

  test('每种操作、最新名字、已上台保持字段、背景变化和输入不可变', () => {
    const state: StageState = {
      scene: { bg: '旧背景', backgroundId: '旧id', time: '白天' },
      cast: [{ ...member('center', 'Alice'), expression: 'joy', outfit: '旧服装' }],
    }
    const before = structuredClone(state)
    const ops: StageOp[] = [
      { op: 'scene', place: '城' },
      { op: 'show', who: ' ALICE ' },
      { op: 'show', who: 'alice', at: 'right', outfit: '礼服' },
      { op: 'expr', who: 'ALIce', expression: 'sadness' },
      { op: 'show', who: '乙' },
      { op: 'expr', who: '丙', expression: 'joy' },
      { op: 'hide', who: ' 乙 ' },
      { op: 'hide', who: '不存在' },
    ]
    const originalOps = structuredClone(ops)
    const next = applyStageOps(state, ops)
    expect(next.scene).toEqual({ ...state.scene, place: '城' })
    expect(next.cast).toEqual([
      { key: '丙', name: '丙', expression: 'joy', at: 'left' },
      { key: 'alice', name: 'ALIce', expression: 'sadness', outfit: '礼服', at: 'right' },
    ])
    expect(state).toEqual(before)
    expect(ops).toEqual(originalOps)
    expect(applyStageOps(state, [{ op: 'scene', bg: '旧背景' }]).scene.backgroundId).toBe('旧id')
    expect(applyStageOps(state, [{ op: 'scene', bg: '新背景', bgm: '新音乐' }]).scene).toEqual({
      bg: '新背景',
      bgm: '新音乐',
      time: '白天',
    })
    expect(applyStageOps(state, [{ op: 'show', who: 'alice' }]).cast[0]).toEqual({ ...state.cast[0]!, name: 'alice' })
  })

  test('三人退一人后分站左右', () => {
    const state: StageState = {
      scene: {},
      cast: [member('left', '甲'), member('center', '乙'), member('right', '丙')],
    }
    expect(applyStageOps(state, [{ op: 'hide', who: '丙' }]).cast).toEqual([
      member('left', '甲'),
      member('right', '乙'),
    ])
  })

  test('连续退场后只剩一人居中，全部退场为空舞台', () => {
    const state: StageState = {
      scene: {},
      cast: [member('left', '甲'), member('center', '乙'), member('right', '丙')],
    }
    const next = applyStageOps(state, [
      { op: 'hide', who: '乙' },
      { op: 'hide', who: '丙' },
    ])
    expect(next.cast).toEqual([member('center', '甲')])
    expect(applyStageOps(next, [{ op: 'hide', who: '甲' }]).cast).toEqual([])
  })

  test('按横坐标保持左右相对顺序，同坐标保持 cast 顺序，多于五人放中间', () => {
    const state: StageState = {
      scene: {},
      cast: [
        member('right', '右'),
        member(5, '最右'),
        member(3, '中一'),
        member(2, '偏左'),
        member('center', '中二'),
        member(1, '最左'),
        member(4, '偏右'),
        member('left', '左'),
        member('center', '退场'),
      ],
    }
    expect(applyStageOps(state, [{ op: 'hide', who: '退场' }]).cast).toEqual([
      member(1, '最左'),
      member(2, '左'),
      member(3, '偏左'),
      member(4, '中一'),
      member(5, '中二'),
      member('center', '偏右'),
      member('center', '右'),
      member('center', '最右'),
    ])
  })

  test('hide 不在台上的人时不重排', () => {
    const state: StageState = { scene: {}, cast: [member(5, '甲'), member(1, '乙')] }
    expect(applyStageOps(state, [{ op: 'hide', who: '不存在' }])).toEqual(state)
  })

  test('没有 hide 时保留新旧角色显式指定的 at', () => {
    const state: StageState = { scene: {}, cast: [member('center', '甲')] }
    expect(
      applyStageOps(state, [
        { op: 'show', who: '甲', at: 5 },
        { op: 'show', who: '乙', at: 1 },
      ]).cast,
    ).toEqual([member(5, '甲'), member(1, '乙')])
  })

  test('五人退到四人使用 1、2、4、5', () => {
    const state: StageState = {
      scene: {},
      cast: [member(1, '甲'), member(2, '乙'), member(3, '丙'), member(4, '丁'), member(5, '戊')],
    }
    expect(applyStageOps(state, [{ op: 'hide', who: '乙' }]).cast).toEqual([
      member(1, '甲'),
      member(2, '丙'),
      member(4, '丁'),
      member(5, '戊'),
    ])
  })

  test('退场当即重排，之后 show 显式写的 at 照常生效，回放结果确定且不修改输入', () => {
    const initial: StageState = { scene: {}, cast: [member(5, '甲'), member(1, '乙')] }
    const ops: StageOp[][] = [
      [
        { op: 'hide', who: '乙' },
        { op: 'show', who: '丙', at: 2 },
        { op: 'show', who: '丁', at: 4 },
      ],
    ]
    const before = structuredClone({ initial, ops })
    const expected: StageState = {
      scene: {},
      cast: [member('center', '甲'), member(2, '丙'), member(4, '丁')],
    }
    expect(foldStage(ops, initial)).toEqual(expected)
    expect(foldStage(ops, initial)).toEqual(expected)
    expect({ initial, ops }).toEqual(before)
  })

  test('foldStage 顺序折叠且不修改初始状态', () => {
    const initial = emptyStage()
    expect(
      foldStage([[{ op: 'show', who: '甲' }], [{ op: 'expr', who: '甲', expression: 'joy' }]], initial).cast,
    ).toEqual([{ key: '甲', name: '甲', at: 'center', expression: 'joy' }])
    expect(initial).toEqual(emptyStage())
  })
})

describe('初始化、schema 与说明模板', () => {
  test('InitVar JSON5、嵌套拍平、规则、数组、顺序覆盖、仅备注匹配、错误跳过', () => {
    const result = parseInitVars([
      { comment: '忽略', content: '{bad' },
      {
        comment: '[InitVar] 开局',
        content: `{ // 注释\n user: {位置: ['教堂', '移动后改变'], 数字: 3,}, array: [1,2,3], /*注释*/ flag: true,}`,
      },
      { comment: '[InitVar] 覆盖', content: "{'user.数字': 4, flag: [false, '开关规则'],}" },
      { comment: '[InitVar] 错误', content: '{bad' },
      { comment: '[InitVar] 非对象', content: '[]' },
    ])
    expect(result.vars).toEqual({ 'user.位置': '教堂', 'user.数字': 4, array: [1, 2, 3], flag: false })
    expect(result.rules).toEqual({ 'user.位置': '移动后改变', flag: '开关规则' })
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0]).toStartWith('[InitVar] 错误：')
    expect(result.errors[1]).toContain('必须是对象')
    expect(
      parseInitVars([
        { comment: '[InitVar]', content: '{x:[1,"规则"]}' },
        { comment: '[InitVar]', content: '{x:2}' },
      ]).rules,
    ).toEqual({})
  })

  test('InitVar 不接受表达式、未闭合结构、非法键或未转义换行', () => {
    for (const content of ['{x: 1 + 2}', '{x: [1, 2}', '{bad.key: 1}', "{x: '未闭合}", "{x: '第一行\n第二行'}"]) {
      const result = parseInitVars([{ comment: '[InitVar]', content }])
      expect(result.vars).toEqual({})
      expect(result.errors).toHaveLength(1)
    }
  })

  test('schema 空串、合法默认值、非法 JSON 和字段校验', () => {
    expect(parseStateSchema(' \n')).toEqual({ schema: {} })
    expect(parseStateSchema('{"x":{"init":0}}')).toEqual({ schema: { x: { type: 'text', init: 0 } } })
    expect(parseStateSchema('{x:1}').error).toContain('JSON')
    for (const source of ['[]', 'null', '{"x":{"type":"bad"}}', '{"x":{"min":"1"}}']) {
      expect(parseStateSchema(source).schema).toEqual({})
      expect(parseStateSchema(source).error).toContain('字段不合法')
    }
    expect(
      schemaInitVars({
        a: { type: 'number', init: 0 },
        b: { type: 'badge', init: false },
        c: { type: 'text' },
        d: { type: 'text', init: null },
      }),
    ).toEqual({ a: 0, b: false, d: null })
    expect(mergeStateSchemas({ a: { type: 'number' } }, { a: { type: 'text' }, b: { type: 'list' } })).toEqual({
      a: { type: 'number' },
      b: { type: 'list' },
    })
  })

  const input: InstructionsInput = {
    outfits: {},
    choicesMode: 'always',
    template: '',
    style: 'shorthand',
    kinds: ['expression', 'state'],
    lists: ['cast', 'expressions', 'backgrounds', 'vars'],
    cast: ['甲', '乙'],
    expressions: ['joy'],
    backgrounds: ['夜'],
    schema: { '艾莉丝.好感': { type: 'meter', min: 0, max: 100, rule: '温柔对待 +1~3' }, 金币: { type: 'number' } },
    rules: { '艾莉丝.好感': '被覆盖', 金币: '花费减少' },
    vars: { '艾莉丝.好感': 35, 背包: ['短剑'] },
    valuesInPrompt: true,
  }

  test.each(['shorthand', 'xml'] as const)('默认说明风格 %s、清单和状态格式', (style) => {
    const result = renderDirectiveInstructions({ ...input, style })
    expect(result).toContain(style === 'shorthand' ? 'name[expression]' : '<say who=')
    expect(result).toContain('Available characters: 甲, 乙')
    expect(result).toContain('Available expressions: joy')
    expect(result).toContain('Available backgrounds: 夜')
    expect(result).toContain(
      'State variables (name: range, update rule; current value):\n- 艾莉丝.好感: 0–100, 温柔对待 +1~3; current: 35\n- 金币: number, 花费减少\n- 背包: current: ["短剑"]',
    )
    expect(result).not.toContain('被覆盖')
    expect(result).not.toContain('{{')
  })

  test('空占位符删除整行，kinds 顺序，valuesInPrompt 和 lists/kinds 开关', () => {
    expect(
      renderDirectiveInstructions({
        ...input,
        template:
          '保留\n角色：{{vn_cast}}\n表情：{{vn_expressions}}\n背景：{{vn_backgrounds}}\n状态：{{vn_state}}\n说明：{{vn_kinds}}',
        lists: [],
        kinds: [],
      }),
    ).toBe('保留')
    const result = renderDirectiveInstructions({ ...input, valuesInPrompt: false })
    expect(result).not.toContain('current:')
    expect(result).toContain('0–100, 温柔对待 +1~3')
    expect(renderDirectiveInstructions({ ...input, schema: {}, vars: {} })).not.toContain('State variables')
    expect(renderDirectiveInstructions({ ...input, kinds: ['cast', 'expression'] }).indexOf('Enter:')).toBeLessThan(
      renderDirectiveInstructions({ ...input, kinds: ['cast', 'expression'] }).indexOf('Put each line of dialogue'),
    )
  })
})

describe('性能', () => {
  test('两万字和五百个标签分别在 50ms 内解析及显示', () => {
    const content = Array.from(
      { length: 500 },
      (_, i) => `${'旁白'.repeat(20)}<show who=甲 at=${(i % 5) + 1}/>\n`,
    ).join('')
    // 先预热，断言衡量稳定调用的解析成本。
    parse(content)
    display(content)
    const start = performance.now()
    const result = parse(content)
    const parsed = performance.now()
    const visible = display(content)
    const displayed = performance.now()
    expect(result.stage.ops).toHaveLength(500)
    expect(visible).toContain('旁白')
    expect(parsed - start).toBeLessThan(50)
    expect(displayed - parsed).toBeLessThan(50)
  })

  test('纯空白、长数字和状态行保持线性扫描', () => {
    const content = `${' '.repeat(20_000)}\n<state>${'路径'.repeat(10_000)}${' '.repeat(20_000)}坏语句</state>`
    const start = performance.now()
    parse(content)
    display(content)
    expect(performance.now() - start).toBeLessThan(50)
    expect(parseInitVars([{ comment: '[InitVar]', content: `{x: ${'1'.repeat(20_000)}z}` }]).errors).toHaveLength(1)
  })

  test('长畸形属性、未闭合标签和空白不会反复回溯', () => {
    const content = `<show ${'a'.repeat(20_000)}>\n${'<state>\n'.repeat(500)}${' '.repeat(20_000)}`
    const start = performance.now()
    parse(content)
    display(content, 'plain', true)
    expect(performance.now() - start).toBeLessThan(50)
  })
})

test('阶段阈值边界和无效数值', () => {
  const stages: [number, string][] = [
    [0, 'Strangers'],
    [40, 'Friends'],
    [90, 'Lovers'],
  ]
  for (const [value, expected] of [
    [-1, ''],
    [0, 'Strangers'],
    [39, 'Strangers'],
    [40, 'Friends'],
    [95, 'Lovers'],
    ['95', ''],
    [null, ''],
    [NaN, ''],
  ]) {
    expect(stateStageName(stages, value)).toBe(expected as string)
  }
  expect(stateStageName(undefined, 95)).toBe('')
})
