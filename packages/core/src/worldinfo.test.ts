import { describe, expect, test } from 'bun:test'
import {
  type LorebookEntryData,
  lorebookEntryDataSchema,
  type WorldInfoSettings,
  worldInfoSettingsSchema,
} from '@ai-parter/shared'
import { matchKey, type ScanEntry, type ScanInput, scanWorldInfo } from './worldinfo'

function entry(id: string, overrides: Partial<LorebookEntryData> & { source?: ScanEntry['source'] } = {}): ScanEntry {
  return {
    ...lorebookEntryDataSchema.parse({ keys: ['龙'], content: id, ...overrides }),
    id,
    lorebookId: 'book',
    lorebookName: '测试世界书',
    source: overrides.source ?? 'character',
  }
}

function scan(entries: ScanEntry[], overrides: Partial<ScanInput> = {}, settings: Partial<WorldInfoSettings> = {}) {
  return scanWorldInfo({
    entries,
    history: [{ name: '用户', content: '一条龙飞过' }],
    settings: worldInfoSettingsSchema.parse(settings),
    type: 'normal',
    characterName: '小明',
    sources: {},
    budget: 10000,
    seed: '固定种子',
    macro: (text) => text,
    countTokens: (text) => text.length,
    ...overrides,
  })
}

function ids(result: ReturnType<typeof scan>): string[] {
  return result.activated.map(({ entry }) => entry.id)
}

describe('matchKey', () => {
  test.each([
    ['cat', 'a category', false, false, true],
    [' CAT ', 'a cat', false, false, true],
    ['CAT', 'a cat', true, false, false],
    ['CAT', 'a CAT', true, false, true],
    ['cat', 'category', false, true, false],
    ['cat', 'bobcat', false, true, false],
    ['cat', '(cat)!', false, true, true],
    ['cat', 'cat', false, true, true],
    ['龙', '一条龙飞过', false, true, true],
    ['red cat', 'bred category', false, true, true],
    ['a+b', 'a+b', false, true, true],
    ['a+b', 'aaab', false, true, false],
    ['[cat]', '[cat]', false, true, true],
    ['/^cat$/im', 'dog\nCAT\nfox', true, true, true],
    ['/c.t/s', 'c\nt', false, false, true],
    ['/cat/g', 'cat', false, false, true],
    ['/cat/', 'CAT', false, false, false],
    ['/[/', 'anything', false, false, false],
    ['/cat/ii', 'cat', false, false, false],
    ['/cat/z', 'cat', false, false, false],
    ['', 'anything', false, false, false],
    ['   ', 'anything', false, true, false],
  ])('%s 对 %s（大小写 %s，全词 %s）→ %s', (key, text, caseSensitive, wholeWords, expected) => {
    expect(matchKey(key, text, { caseSensitive, wholeWords })).toBe(expected)
  })

  test('带状态的正则重复调用结果一致', () => {
    for (let i = 0; i < 3; i++) expect(matchKey('/cat/g', 'cat', { caseSensitive: false, wholeWords: true })).toBe(true)
  })
})

describe('scanWorldInfo', () => {
  test('常驻无视关键词及可选过滤；报告包含未命中项和完整元数据', () => {
    const result = scan(
      [
        entry('常驻', { constant: true, keys: [], secondaryKeys: ['无'], comment: '标题', content: '内容' }),
        entry('未中', { keys: ['海'] }),
      ],
      { history: [] },
    )
    expect(ids(result)).toEqual(['常驻'])
    expect(result.activated[0]).toMatchObject({ content: '内容', reason: '常驻', tokens: 2 })
    expect(result.report).toEqual([
      {
        entryId: '常驻',
        lorebookId: 'book',
        lorebookName: '测试世界书',
        comment: '标题',
        position: 'before_char',
        reason: '常驻',
        activated: true,
        tokens: 2,
      },
      {
        entryId: '未中',
        lorebookId: 'book',
        lorebookName: '测试世界书',
        comment: '',
        position: 'before_char',
        reason: '',
        activated: false,
        tokens: 0,
        skippedReason: '未命中关键词',
      },
    ])
  })

  test.each([
    ['and_any', ['龙', '海'], ['海', '山']],
    ['and_all', ['龙', '飞'], ['龙', '海']],
    ['not_any', ['海', '山'], ['龙', '海']],
    ['not_all', ['龙', '海'], ['龙', '飞']],
  ] as const)('可选过滤 %s 的正反例', (selectiveLogic, passing, failing) => {
    const result = scan([
      entry('通过', { selectiveLogic, secondaryKeys: [...passing] }),
      entry('失败', { selectiveLogic, secondaryKeys: [...failing] }),
      entry('空过滤', { selectiveLogic, secondaryKeys: [] }),
    ])
    expect(ids(result)).toEqual(['通过', '空过滤'])
    expect(result.report[1]).toMatchObject({ reason: '', skippedReason: '未命中关键词', tokens: 0 })
  })

  test('主关键词任一匹配，但可选过滤不能独立激活', () => {
    expect(
      ids(
        scan([
          entry('命中', { keys: ['海', '龙'] }),
          entry('无主键', { keys: [], secondaryKeys: ['龙'] }),
          entry('主键未中', { keys: ['海'], secondaryKeys: ['龙'] }),
        ]),
      ),
    ).toEqual(['命中'])
  })

  test('候选过滤：触发类型、包含或排除角色、延迟、禁用及空 outlet 不进入报告', () => {
    const result = scan([
      entry('类型通过', { triggers: ['normal', 'continue'] }),
      entry('类型失败', { triggers: ['continue'] }),
      entry('包含通过', { characterFilter: { names: ['小明'], exclude: false } }),
      entry('包含失败', { characterFilter: { names: ['小红'], exclude: false } }),
      entry('排除通过', { characterFilter: { names: ['小红'], exclude: true } }),
      entry('排除失败', { characterFilter: { names: ['小明'], exclude: true } }),
      entry('空排除', { characterFilter: { names: [], exclude: true } }),
      entry('延迟通过', { delay: 1 }),
      entry('延迟失败', { delay: 2 }),
      entry('禁用', { enabled: false, constant: true }),
      entry('空出口', { position: 'outlet', outletName: '' }),
      entry('有出口', { position: 'outlet', outletName: '出口' }),
    ])
    expect(result.report.map((item) => item.entryId)).toEqual([
      '类型通过',
      '包含通过',
      '排除通过',
      '空排除',
      '延迟通过',
      '有出口',
    ])
    expect(result.report.every((item) => item.activated)).toBe(true)
  })

  test('扫描深度使用全局值并允许逐条覆盖，0 不扫描聊天', () => {
    const entries = [
      entry('全局'),
      entry('深度二', { scanDepth: 2 }),
      entry('深度零', { scanDepth: 0 }),
      entry('常驻', { scanDepth: 0, constant: true }),
    ]
    const history = [
      { name: '用户', content: '龙' },
      { name: '用户', content: '海' },
    ]
    expect(ids(scan(entries, { history }, { scanDepth: 1, recursive: false }))).toEqual(['深度二', '常驻'])
    expect(ids(scan(entries, { history }, { scanDepth: 2, recursive: false }))).toEqual(['全局', '深度二', '常驻'])
    expect(ids(scan(entries, { history }, { scanDepth: 0, recursive: false }))).toEqual(['深度二', '常驻'])
  })

  test('includeNames 控制名字触发并按规定添加前缀和换行', () => {
    const entries = [
      entry('名字', { keys: ['Alice'] }),
      entry('格式', { keys: ['/\\x01Alice: hello\\n\\x01Bob: bye/'] }),
    ]
    const history = [
      { name: 'Alice', content: 'hello' },
      { name: 'Bob', content: 'bye' },
    ]
    expect(ids(scan(entries, { history }, { includeNames: true }))).toEqual(['名字', '格式'])
    expect(ids(scan(entries, { history }, { includeNames: false }))).toEqual([])
  })

  test('条目匹配设置覆盖全局设置，null 则继承', () => {
    expect(
      ids(
        scan(
          [
            entry('继承', { keys: ['CAT'] }),
            entry('忽略大小写', { keys: ['CAT'], caseSensitive: false, matchWholeWords: false }),
            entry('区分大小写', { keys: ['CAT'], caseSensitive: true, matchWholeWords: false }),
            entry('全词', { keys: ['cat'], caseSensitive: false, matchWholeWords: true }),
          ],
          { history: [{ name: '', content: 'category' }] },
          { caseSensitive: true, matchWholeWords: false },
        ),
      ),
    ).toEqual(['忽略大小写'])
    expect(ids(scan([entry('继承全词', { keys: ['cat'] })], { history: [{ name: '', content: 'category' }] }))).toEqual(
      [],
    )
  })

  test('只拼接条目选中的额外来源，深度为 0 仍可触发', () => {
    expect(
      ids(
        scan(
          [
            entry('描述', { scanDepth: 0, matchSources: ['char_description'] }),
            entry('未选来源', { scanDepth: 0 }),
            entry('缺失来源', { scanDepth: 0, matchSources: ['scenario'] }),
          ],
          { sources: { char_description: '龙族少女' } },
        ),
      ),
    ).toEqual(['描述'])
  })

  test('递归传播宏替换后的内容并给出递归原因', () => {
    const result = scan([
      entry('A', { content: '海' }),
      entry('B', { keys: ['海'], content: '山' }),
      entry('C', { keys: ['山'], scanDepth: 0 }),
    ])
    expect(ids(result)).toEqual(['A', 'B', 'C'])
    expect(result.activated.map((item) => item.reason)).toEqual(['关键词：龙', '递归：海', '递归：山'])
  })

  test('excludeRecursion 只禁止递归触发，preventRecursion 不传播内容', () => {
    expect(ids(scan([entry('A', { content: '海' }), entry('B', { keys: ['海'], excludeRecursion: true })]))).toEqual([
      'A',
    ])
    expect(ids(scan([entry('A', { content: '海', preventRecursion: true }), entry('B', { keys: ['海'] })]))).toEqual([
      'A',
    ])
    expect(ids(scan([entry('A', { excludeRecursion: true })]))).toEqual(['A'])
  })

  test('delayUntilRecursion 首轮跳过，递归只匹配缓冲区，不重新匹配聊天或额外来源', () => {
    const result = scan(
      [
        entry('A', { content: '海' }),
        entry('缓冲区', { keys: ['海'], delayUntilRecursion: true }),
        entry('聊天', { delayUntilRecursion: true }),
        entry('额外来源', { keys: ['山'], delayUntilRecursion: true, matchSources: ['char_description'] }),
        entry('延迟常驻', { constant: true, delayUntilRecursion: true }),
      ],
      { sources: { char_description: '山' } },
    )
    expect(ids(result)).toEqual(['A', '缓冲区', '延迟常驻'])
    expect(ids(scan([entry('延迟', { constant: true, delayUntilRecursion: true })]))).toEqual([])
    expect(
      ids(
        scan(
          [entry('A', { content: '海' }), entry('延迟', { keys: ['海'], delayUntilRecursion: true })],
          {},
          { recursive: false },
        ),
      ),
    ).toEqual(['A'])
  })

  test('递归可选过滤也只匹配缓冲区，并保留更早轮次的内容', () => {
    const result = scan([
      entry('A', { content: '海' }),
      entry('B', { keys: ['海'], content: '山' }),
      entry('C', { keys: ['山'], secondaryKeys: ['海'] }),
      entry('D', { keys: ['海'], secondaryKeys: ['龙'] }),
    ])
    expect(ids(result)).toEqual(['A', 'B', 'C'])
  })

  test('maxRecursionSteps 限制递归轮数；0 最多十轮；recursive=false 只扫第 0 轮', () => {
    const entries = Array.from({ length: 13 }, (_, i) =>
      entry(String(i), { keys: [`词${i}。`], content: `词${i + 1}。` }),
    )
    const overrides = { history: [{ name: '', content: '词0。' }] }
    expect(ids(scan(entries, overrides, { maxRecursionSteps: 1 }))).toEqual(['0', '1'])
    expect(ids(scan(entries, overrides, { maxRecursionSteps: 2 }))).toEqual(['0', '1', '2'])
    expect(ids(scan(entries, overrides, { maxRecursionSteps: 0 }))).toEqual(
      Array.from({ length: 11 }, (_, i) => String(i)),
    )
    expect(ids(scan(entries, overrides, { recursive: false }))).toEqual(['0'])
  })

  test('概率 0 永不插入、100 总插入，关闭概率则忽略配置', () => {
    const result = scan([
      entry('零', { probability: 0, constant: true, content: '海' }),
      entry('百', { probability: 100 }),
      entry('关闭', { probability: 0, useProbability: false }),
      entry('不能传播', { keys: ['海'] }),
    ])
    expect(ids(result)).toEqual(['百', '关闭'])
    expect(result.report[0]).toMatchObject({ skippedReason: '概率未命中', reason: '常驻', tokens: 0 })
    expect(result.report[3]).toMatchObject({ skippedReason: '未命中关键词' })
  })

  test('相同种子完全可复现，不同种子在大量条目上产生差异', () => {
    const entries = Array.from({ length: 100 }, (_, i) => entry(String(i), { probability: 50 }))
    const first = scan(entries, { seed: '一' })
    expect(scan(entries, { seed: '一' })).toEqual(first)
    expect(ids(scan(entries, { seed: '二' }))).not.toEqual(ids(first))
    expect(first.activated.length).toBeGreaterThan(20)
    expect(first.activated.length).toBeLessThan(80)
    expect(
      first.report
        .filter((item) => !item.activated)
        .every((item) => item.tokens === 0 && item.skippedReason === '概率未命中'),
    ).toBe(true)
  })

  test('包含组有优先标记时按整个组的最大 order 选择，常驻也参与', () => {
    const result = scan([
      entry('常驻', { constant: true, group: '  组  ', groupPrioritize: true, order: 1, content: '海' }),
      entry('最大', { group: '组', order: 3 }),
      entry('同序', { group: '组', order: 3 }),
      entry('不能传播', { keys: ['海'] }),
    ])
    expect(ids(result)).toEqual(['最大'])
    expect(result.report[0]).toMatchObject({ skippedReason: '包含组：组', tokens: 0 })
    expect(result.report[2]).toMatchObject({ skippedReason: '包含组：组', tokens: 0 })
  })

  test('包含组加权随机可复现，重权重条目在多个种子中更常被选中', () => {
    const entries = [entry('轻', { group: '组', groupWeight: 1 }), entry('重', { group: '组', groupWeight: 9 })]
    const first = scan(entries)
    expect(scan(entries)).toEqual(first)
    let heavy = 0
    for (let i = 0; i < 100; i++) {
      const result = scan(entries, { seed: String(i) })
      expect(result.activated).toHaveLength(1)
      if (result.activated[0]?.entry.id === '重') heavy++
    }
    expect(heavy).toBeGreaterThan(70)
    expect(heavy).toBeLessThan(100)
  })

  test('条目可以属于多个组，组名 trim 去重，淘汰条目不再竞争', () => {
    const result = scan([
      entry('双组', { group: '甲, 乙,甲, ', order: 2, groupPrioritize: true }),
      entry('甲落选', { group: '甲', order: 1 }),
      entry('乙胜出', { group: '乙', order: 3, groupPrioritize: true }),
      entry('无组', { group: ' , ' }),
    ])
    expect(ids(result)).toEqual(['乙胜出', '无组'])
    expect(result.report[0]?.skippedReason).toBe('包含组：乙')
    expect(result.report[1]?.skippedReason).toBe('包含组：甲')
  })

  test('包含组按轮次竞争，前一轮的赢家不会淘汰后一轮触发的条目', () => {
    expect(ids(scan([entry('A', { group: '组', content: '海' }), entry('B', { group: '组', keys: ['海'] })]))).toEqual([
      'A',
      'B',
    ])
  })

  test('预算常驻优先，然后 order 降序；首次超限之后即使较小或为空也全部跳过', () => {
    const result = scan(
      [
        entry('低序', { order: 10, content: 'x' }),
        entry('高序', { order: 20, content: 'yyy' }),
        entry('超限', { order: 15, content: 'zz' }),
        entry('常驻', { constant: true, order: 0, content: 'ab' }),
        entry('空内容', { order: -1, content: '' }),
      ],
      { budget: 6 },
    )
    expect(ids(result)).toEqual(['常驻', '高序'])
    expect(result.activated.map((item) => item.tokens)).toEqual([2, 3])
    for (const id of ['低序', '超限', '空内容']) {
      expect(result.report.find((item) => item.entryId === id)).toMatchObject({
        activated: false,
        skippedReason: '超出预算',
        tokens: 0,
      })
    }
  })

  test('恰好等于预算可插入，零预算可插入空内容；计数使用宏展开内容', () => {
    expect(ids(scan([entry('A', { content: 'ab' }), entry('B', { content: 'c' })], { budget: 3 }))).toEqual(['A', 'B'])
    expect(ids(scan([entry('空', { content: '' }), entry('非空')], { budget: 0 }))).toEqual(['空'])
    const result = scan([entry('宏', { content: '{{char}}' })], {
      macro: (text) => text.replaceAll('{{char}}', '小明'),
      countTokens: (text) => text.length * 2,
      budget: 4,
    })
    expect(result.activated[0]).toMatchObject({ content: '小明', tokens: 4 })
  })

  test('预算最后统一处理：预算淘汰的内容此前仍可触发递归条目', () => {
    const result = scan(
      [entry('A', { content: '海', order: 1 }), entry('B', { keys: ['海'], content: 'b', order: 2 })],
      { budget: 1 },
    )
    expect(ids(result)).toEqual(['B'])
    expect(result.report[0]?.skippedReason).toBe('超出预算')
  })

  test.each([
    ['character_first', ['chat', 'persona', 'c1', 'c2', 'g1', 'g2']],
    ['global_first', ['chat', 'persona', 'g1', 'g2', 'c1', 'c2']],
    ['evenly', ['chat', 'persona', 'g1', 'c1', 'g2', 'c2']],
  ] as const)('插入策略 %s：来源优先，同级 order 升序，同序保持输入顺序', (insertionStrategy, expected) => {
    const entries = [
      entry('g2', { source: 'global', order: 20 }),
      entry('c2', { source: 'character', order: 20 }),
      entry('g1', { source: 'global', order: 10 }),
      entry('c1', { source: 'character', order: 10 }),
      entry('persona', { source: 'persona', order: 200 }),
      entry('chat', { source: 'chat', order: 300 }),
    ]
    expect(ids(scan(entries, {}, { insertionStrategy }))).toEqual([...expected])
  })

  test('宏替换作用于主关键词、可选关键词和传播内容；输入不被修改', () => {
    const entries = [
      entry('A', { keys: ['{{char}}'], secondaryKeys: ['{{char}}'], content: '{{place}}' }),
      entry('B', { keys: ['海'] }),
    ]
    const original = structuredClone(entries)
    const result = scan(entries, { macro: (text) => text.replaceAll('{{char}}', '龙').replaceAll('{{place}}', '海') })
    expect(ids(result)).toEqual(['A', 'B'])
    expect(result.activated[0]).toMatchObject({ reason: '关键词：龙', content: '海', tokens: 1 })
    expect(result.activated[1]?.reason).toBe('递归：海')
    expect(entries).toEqual(original)
  })

  test('未实现的配置仅保存，不影响激活', () => {
    expect(
      ids(
        scan([
          entry('保存字段', { sticky: 10, cooldown: 10, groupScoring: true, automationId: '自动化', vectorized: true }),
        ]),
      ),
    ).toEqual(['保存字段'])
  })
})
