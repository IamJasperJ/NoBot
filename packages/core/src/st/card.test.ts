import { describe, expect, test } from 'bun:test'
import { characterExtrasSchema, characterFieldsSchema, lorebookEntryDataSchema } from '@nobot/shared'
import { parseCardJson } from '../cards/card'
import { buildCardExport, importSTWorldInfo, readCardExtras } from './index'

const fields = characterFieldsSchema.parse({
  name: '艾莉丝',
  description: '新描述',
  creator: '作者',
  character_version: '1.2',
  personality: '活泼',
  scenario: '森林',
  first_mes: '你好',
  alternate_greetings: ['欢迎'],
  mes_example: '示例',
  system_prompt: '系统',
  post_history_instructions: '历史后',
  creator_notes: '备注',
  tags: ['魔法师'],
})
const extras = characterExtrasSchema.parse({
  talkativeness: 0.8,
  characterNote: '维持角色',
  characterNoteDepth: 7,
  characterNoteRole: 'assistant',
})

describe('角色卡导出和额外字段', () => {
  test('保留未知字段、扩展和 V3 群聊开场白；覆盖字段且不修改输入', () => {
    const raw = {
      spec: 'chara_card_v3',
      data: {
        name: '旧名字',
        description: '旧描述',
        unknown: { nested: ['保留'] },
        extensions: { custom: { enabled: true }, talkativeness: 0.1, depth_prompt: { custom: '保留' } },
        character_book: { entries: [] },
        group_only_greetings: ['群聊你好'],
      },
    }
    const input = {
      fields,
      extras,
      raw,
      book: { name: '内嵌', entries: [lorebookEntryDataSchema.parse({ keys: ['龙'], content: '龙族' })] },
    }
    const before = structuredClone(input)
    const result = buildCardExport(input)
    expect(input).toEqual(before)
    expect(result.v2).toMatchObject({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        ...fields,
        unknown: { nested: ['保留'] },
        extensions: {
          custom: { enabled: true },
          talkativeness: 0.8,
          depth_prompt: { custom: '保留', prompt: '维持角色', depth: 7, role: 'assistant' },
        },
      },
    })
    expect(result.v3).toMatchObject({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: { group_only_greetings: ['群聊你好'] },
    })
    for (const card of [result.v2, result.v3]) {
      const parsed = parseCardJson(card)
      expect(parsed.fields).toEqual(fields)
      expect(parsed.extras).toEqual({
        talkativeness: 0.8,
        characterNote: '维持角色',
        characterNoteDepth: 7,
        characterNoteRole: 'assistant',
      })
      expect(importSTWorldInfo(parsed.characterBook)).toEqual(input.book)
    }
    expect(result.v2.data).not.toBe(result.v3.data)
    expect(result.v2.data).not.toBe(raw.data)
  })

  test('无 book 时删除旧世界书，支持 V1 和无原始卡', () => {
    for (const raw of [
      null,
      { name: '旧卡', custom: true, character_book: { entries: [] } },
      { spec: 'chara_card_v2', data: { custom: true, character_book: { entries: [] } } },
    ]) {
      const before = structuredClone(raw)
      const { v2, v3 } = buildCardExport({ fields, extras, raw, book: null })
      expect(parseCardJson(v2).characterBook).toBeNull()
      expect(parseCardJson(v3).characterBook).toBeNull()
      expect(v3).toMatchObject({ data: { group_only_greetings: [] } })
      if (raw) expect(v2).toMatchObject({ data: { custom: true } })
      expect(raw).toEqual(before)
    }
  })

  test('V1 的未知 data 字段保留在原位置', () => {
    const raw = { name: '旧名字', data: { vendor: '保留' } }
    const result = buildCardExport({ fields, extras, raw, book: null })
    expect(result.v2).toMatchObject({ data: { name: fields.name, data: { vendor: '保留' } } })
    expect(raw).toEqual({ name: '旧名字', data: { vendor: '保留' } })
  })

  test('读取合法数字字符串、边界值和所有备注角色', () => {
    for (const value of ['0.75', ' 0.5 ', 0, 1, '0', '1']) {
      expect(readCardExtras({ extensions: { talkativeness: value } })).toEqual({ talkativeness: Number(value) })
    }
    for (const role of ['system', 'user', 'assistant'] as const) {
      expect(readCardExtras({ extensions: { depth_prompt: { prompt: '', depth: 0, role } } })).toEqual({
        characterNote: '',
        characterNoteDepth: 0,
        characterNoteRole: role,
      })
    }
  })

  test('非法设置被忽略，缺字段不填默认值', () => {
    for (const value of ['', ' ', 'abc', '-1', '2', -1, 2, Infinity, NaN, null, true, {}, []]) {
      expect(readCardExtras({ extensions: { talkativeness: value } })).toEqual({})
    }
    for (const extensions of [
      undefined,
      null,
      [],
      '错误',
      {},
      { depth_prompt: false },
      { depth_prompt: { prompt: 1, depth: -1, role: 0 } },
      { depth_prompt: { depth: '4' } },
      { depth_prompt: { depth: 1.2 } },
    ]) {
      expect(readCardExtras({ extensions })).toEqual({})
    }
    expect(readCardExtras({ extensions: { depth_prompt: { prompt: '保留', depth: Infinity, role: '错误' } } })).toEqual(
      { characterNote: '保留' },
    )
  })
})

test('扩展字段在各版本卡中透传，导出本应用字段优先且不恢复已删除的扩展键', () => {
  const data = {
    name: '测试',
    description: '',
    extensions: {
      talkativeness: 0.3,
      depth_prompt: { prompt: '备注' },
      sd_character_prompt: '银龙',
      other: { enabled: true },
    },
  }
  for (const raw of [data, { spec: 'chara_card_v2', data }, { spec: 'chara_card_v3', data }]) {
    expect(parseCardJson(raw).extensions).toEqual({ sd_character_prompt: '银龙', other: { enabled: true } })
    const extensions = { sd_character_prompt: '更新后的银龙', talkativeness: 0, depth_prompt: { prompt: '不应覆盖' } }
    const before = structuredClone(extensions)
    const result = buildCardExport({ fields, extras, extensions, raw, book: null })
    for (const card of [result.v2, result.v3]) {
      const parsed = parseCardJson(card)
      expect(parsed.extensions).toEqual({ sd_character_prompt: '更新后的银龙' })
      expect(parsed.extras).toMatchObject({ talkativeness: extras.talkativeness, characterNote: extras.characterNote })
    }
    expect(extensions).toEqual(before)
  }
})
