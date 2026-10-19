import { describe, expect, test } from 'bun:test'
import { lorebookEntryDataSchema } from '@nobot/shared'
import { exportSTWorldInfo, importSTWorldInfo, STFormatError, toCharacterBook } from './index'

const entry = {
  uid: 42,
  displayIndex: 1,
  key: ['龙', '/魔法/i'],
  keysecondary: ['山脉'],
  comment: '龙族',
  content: '龙族守护山脉',
  constant: true,
  selective: true,
  selectiveLogic: 3,
  order: 123,
  depth: 8,
  probability: 63,
  useProbability: false,
  position: 4,
  disable: true,
  excludeRecursion: true,
  preventRecursion: true,
  delayUntilRecursion: true,
  group: '龙族,生物',
  groupOverride: true,
  groupWeight: 28,
  useGroupScoring: true,
  scanDepth: 12,
  caseSensitive: true,
  matchWholeWords: false,
  role: 2,
  sticky: 3,
  cooldown: 4,
  delay: 5,
  automationId: '龙族宏',
  vectorized: true,
  characterFilter: { isExclude: true, names: ['艾莉丝'] },
  triggers: ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'],
  outletName: '世界',
  matchCharacterDescription: true,
  matchCharacterPersonality: true,
  matchScenario: true,
  matchPersonaDescription: true,
  matchCharacterDepthPrompt: true,
  matchCreatorNotes: true,
}
const expected = lorebookEntryDataSchema.parse({
  keys: ['龙', '/魔法/i'],
  secondaryKeys: ['山脉'],
  comment: '龙族',
  content: '龙族守护山脉',
  constant: true,
  selectiveLogic: 'and_all',
  order: 123,
  depth: 8,
  probability: 63,
  useProbability: false,
  position: 'at_depth',
  enabled: false,
  excludeRecursion: true,
  preventRecursion: true,
  delayUntilRecursion: true,
  group: '龙族,生物',
  groupPrioritize: true,
  groupWeight: 28,
  groupScoring: true,
  scanDepth: 12,
  caseSensitive: true,
  matchWholeWords: false,
  role: 'assistant',
  sticky: 3,
  cooldown: 4,
  delay: 5,
  automationId: '龙族宏',
  vectorized: true,
  characterFilter: { exclude: true, names: ['艾莉丝'] },
  triggers: ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'],
  outletName: '世界',
  matchSources: ['char_description', 'char_personality', 'scenario', 'persona', 'char_note', 'creator_notes'],
})
const embeddedEntry = {
  id: 42,
  keys: ['龙', '/魔法/i'],
  secondary_keys: ['山脉'],
  name: '龙族',
  content: '龙族守护山脉',
  constant: true,
  selective: true,
  enabled: false,
  insertion_order: 123,
  case_sensitive: false,
  position: 'after_char',
  extensions: {
    position: 4,
    depth: 8,
    probability: 63,
    useProbability: false,
    selectiveLogic: 3,
    exclude_recursion: true,
    prevent_recursion: true,
    delay_until_recursion: true,
    match_whole_words: false,
    case_sensitive: true,
    group: '龙族,生物',
    group_override: true,
    group_weight: 28,
    scan_depth: 12,
    role: 2,
    sticky: 3,
    cooldown: 4,
    delay: 5,
    automation_id: '龙族宏',
    vectorized: true,
  },
}

describe('世界书互转', () => {
  test('酒馆世界书完整映射，并以 displayIndex 排序', () => {
    const result = importSTWorldInfo({
      name: '龙族世界',
      entries: { '42': entry, '99': { ...entry, displayIndex: 0, comment: '第一条' } },
    })
    expect(result.name).toBe('龙族世界')
    expect(result.entries).toEqual([{ ...expected, comment: '第一条' }, expected])
    expect(
      importSTWorldInfo({ entries: { '12': { comment: '后' }, '2': { comment: '前' } } }).entries.map((e) => e.comment),
    ).toEqual(['前', '后'])
  })

  test('V2 character_book 的外层字段和 extensions 优先级', () => {
    const result = importSTWorldInfo({ name: '内嵌世界', entries: [embeddedEntry] })
    expect(result.name).toBe('内嵌世界')
    expect(result.entries).toEqual([
      {
        ...expected,
        groupScoring: false,
        characterFilter: { names: [], exclude: false },
        triggers: [],
        outletName: '',
        matchSources: [],
      },
    ])
    const fallback = importSTWorldInfo({ entries: [{ ...embeddedEntry, comment: '备注优先', extensions: {} }] })
      .entries[0]
    expect(fallback?.comment).toBe('备注优先')
    expect(fallback?.position).toBe('after_char')
    expect(fallback?.caseSensitive).toBe(false)
    expect(
      importSTWorldInfo({
        entries: [{ position: 'before_char', case_sensitive: true, extensions: { case_sensitive: null } }],
      }).entries[0]?.caseSensitive,
    ).toBeNull()
  })

  test('全部位置、关键词逻辑和角色的数字映射双向覆盖', () => {
    const positions = [
      'before_char',
      'after_char',
      'before_an',
      'after_an',
      'at_depth',
      'before_em',
      'after_em',
      'outlet',
    ] as const
    const logics = ['and_any', 'not_all', 'not_any', 'and_all'] as const
    const roles = ['system', 'user', 'assistant'] as const
    for (const [position, value] of positions.entries()) {
      const data = importSTWorldInfo({ entries: { '0': { position } } }).entries
      expect(data[0]?.position).toBe(value)
      expect(exportSTWorldInfo(data)).toMatchObject({ entries: { '0': { position } } })
      expect(importSTWorldInfo({ entries: [{ extensions: { position } }] }).entries[0]?.position).toBe(value)
      expect(toCharacterBook('位置', data)).toMatchObject({ entries: [{ extensions: { position } }] })
    }
    for (const [selectiveLogic, value] of logics.entries()) {
      const data = importSTWorldInfo({ entries: { '0': { selectiveLogic } } }).entries
      expect(data[0]?.selectiveLogic).toBe(value)
      expect(exportSTWorldInfo(data)).toMatchObject({ entries: { '0': { selectiveLogic } } })
      expect(importSTWorldInfo({ entries: [{ extensions: { selectiveLogic } }] }).entries[0]?.selectiveLogic).toBe(
        value,
      )
    }
    for (const [role, value] of roles.entries()) {
      const data = importSTWorldInfo({ entries: { '0': { role } } }).entries
      expect(data[0]?.role).toBe(value)
      expect(exportSTWorldInfo(data)).toMatchObject({ entries: { '0': { role } } })
      expect(importSTWorldInfo({ entries: [{ extensions: { role } }] }).entries[0]?.role).toBe(value)
    }
    expect(importSTWorldInfo({ entries: { '0': { role: null } } }).entries[0]?.role).toBe('system')
  })

  test('全部字段经世界书和内嵌格式往返，uid 使用下标', () => {
    const entries = [expected, lorebookEntryDataSchema.parse({})]
    expect(importSTWorldInfo(exportSTWorldInfo(entries))).toEqual({ name: null, entries })
    expect(exportSTWorldInfo(entries)).toMatchObject({
      entries: { '0': { uid: 0, displayIndex: 0 }, '1': { uid: 1, displayIndex: 1 } },
    })
    expect(importSTWorldInfo(toCharacterBook('龙族', entries))).toEqual({ name: '龙族', entries })
    expect(toCharacterBook('龙族', entries)).toMatchObject({
      name: '龙族',
      entries: [
        {
          keys: expected.keys,
          secondary_keys: expected.secondaryKeys,
          insertion_order: 123,
          enabled: false,
          selective: true,
          case_sensitive: true,
          position: 'before_char',
          extensions: embeddedEntry.extensions,
        },
        { selective: false },
      ],
    })
  })

  test('缺字段、错误类型、越界数值和继承设置', () => {
    const defaults = lorebookEntryDataSchema.parse({})
    expect(importSTWorldInfo({ name: 3, entries: {} })).toEqual({ name: null, entries: [] })
    expect(importSTWorldInfo({ entries: [] })).toEqual({ name: null, entries: [] })
    expect(importSTWorldInfo({ entries: { '0': {} } }).entries).toEqual([defaults])
    expect(importSTWorldInfo({ entries: [{}] }).entries).toEqual([defaults])
    const result = importSTWorldInfo({
      entries: {
        '0': {
          key: ['保留', null, 1],
          keysecondary: false,
          content: 3,
          constant: 'true',
          disable: 'false',
          role: 8,
          position: -1,
          selectiveLogic: '3',
          probability: 200,
          depth: -1,
          scanDepth: 1001,
          groupWeight: 0,
          order: 1.5,
          delay: Infinity,
          sticky: -1,
          cooldown: NaN,
          caseSensitive: null,
          matchWholeWords: 'false',
          characterFilter: { isExclude: 'true', names: ['角色', 1] },
          triggers: ['normal', '未知', false],
          matchScenario: 'true',
        },
      },
    }).entries[0]
    expect(result).toEqual({
      ...defaults,
      keys: ['保留'],
      characterFilter: { names: ['角色'], exclude: false },
      triggers: ['normal'],
    })
    expect(
      importSTWorldInfo({
        entries: [{ position: 'after_char', extensions: { position: 99, depth: -3, role: 'assistant' } }],
      }).entries[0],
    ).toEqual({ ...defaults, position: 'after_char' })
  })

  test('无效结构抛中文 STFormatError', () => {
    for (const value of [
      null,
      [],
      false,
      1,
      '',
      {},
      { entries: null },
      { entries: 'bad' },
      { entries: [null] },
      { entries: { '0': 1 } },
    ]) {
      expect(() => importSTWorldInfo(value)).toThrow(STFormatError)
      expect(() => importSTWorldInfo(value)).toThrow(/酒馆|世界书/)
    }
  })
})
