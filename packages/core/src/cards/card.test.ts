import { describe, expect, test } from 'bun:test'
import { CardParseError, parseCardFile, parseCardJson } from './card'
import { readPngTextChunks, writePngTextChunks } from './png'

// 一张 1x1 的透明 PNG
const TINY_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
)

const toBase64 = (obj: unknown) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')

describe('parseCardJson', () => {
  test('V2 卡从 data 读字段', () => {
    const card = parseCardJson({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: { name: '艾莉丝', description: '一位魔法师', alternate_greetings: ['你好', 1] },
    })
    expect(card.spec).toBe('v2')
    expect(card.fields.name).toBe('艾莉丝')
    expect(card.fields.description).toBe('一位魔法师')
    // 非字符串元素被丢掉
    expect(card.fields.alternate_greetings).toEqual(['你好'])
    expect(card.fields.personality).toBe('')
  })

  test('V1 卡字段在顶层', () => {
    const card = parseCardJson({ name: 'Bob', first_mes: 'Hi' })
    expect(card.spec).toBe('v1')
    expect(card.fields.first_mes).toBe('Hi')
  })

  test('保留自带世界书和原始数据', () => {
    const raw = { spec: 'chara_card_v3', data: { name: 'A', character_book: { entries: [] } } }
    const card = parseCardJson(raw)
    expect(card.spec).toBe('v3')
    expect(card.characterBook).toEqual({ entries: [] })
    expect(card.raw).toBe(raw)
  })

  test('只有 name 的普通 JSON（比如 package.json）不当成角色卡', () => {
    expect(() => parseCardJson({ name: 'ai-parter', version: '1.0.0' })).toThrow(CardParseError)
  })

  test('没有名字时报错', () => {
    expect(() => parseCardJson({ spec: 'chara_card_v2', data: {} })).toThrow(CardParseError)
  })
})

describe('PNG 角色卡', () => {
  test('写入后能读回，中文不乱码', () => {
    const json = { spec: 'chara_card_v2', data: { name: '小雪', description: '雪国的少女' } }
    const png = writePngTextChunks(TINY_PNG, { chara: toBase64(json) })
    const card = parseCardFile(png)
    expect(card.fields.name).toBe('小雪')
    expect(card.fields.description).toBe('雪国的少女')
  })

  test('同时有 V2 和 V3 时优先读 V3', () => {
    const png = writePngTextChunks(TINY_PNG, {
      chara: toBase64({ spec: 'chara_card_v2', data: { name: 'v2' } }),
      ccv3: toBase64({ spec: 'chara_card_v3', data: { name: 'v3' } }),
    })
    expect(parseCardFile(png).fields.name).toBe('v3')
  })

  test('重复写入会替换旧的同名块', () => {
    const once = writePngTextChunks(TINY_PNG, { chara: toBase64({ name: 'a', description: '' }) })
    const twice = writePngTextChunks(once, { chara: toBase64({ name: 'b', description: '' }) })
    expect(readPngTextChunks(twice).size).toBe(1)
    expect(parseCardFile(twice).fields.name).toBe('b')
  })

  test('没有角色卡数据的 PNG 报错', () => {
    expect(() => parseCardFile(TINY_PNG)).toThrow('没有角色卡数据')
  })

  test('JSON 文件也能导入', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ name: 'JSON 角色', first_mes: '你好' }))
    expect(parseCardFile(bytes).fields.name).toBe('JSON 角色')
  })
})

describe('角色卡作者和额外设置', () => {
  test('V1、V2、V3 都读取 creator、character_version 和 extras', () => {
    const data = {
      name: '测试角色',
      description: '',
      creator: '作者',
      character_version: '2.1',
      extensions: {
        talkativeness: '0.7',
        depth_prompt: { prompt: '角色备注', depth: 6, role: 'user' },
      },
    }
    for (const raw of [data, { spec: 'chara_card_v2', data }, { spec: 'chara_card_v3', data }]) {
      const parsed = parseCardJson(raw)
      expect(parsed.fields.creator).toBe('作者')
      expect(parsed.fields.character_version).toBe('2.1')
      expect(parsed.extras).toEqual({
        talkativeness: 0.7,
        characterNote: '角色备注',
        characterNoteDepth: 6,
        characterNoteRole: 'user',
      })
      expect(parsed.raw).toBe(raw)
    }
  })

  test('缺失或错误类型的作者信息用默认值，非法 extras 忽略', () => {
    for (const data of [
      { name: '测试', description: '' },
      {
        name: '测试',
        description: '',
        creator: 123,
        character_version: false,
        extensions: {
          talkativeness: '无效',
          depth_prompt: { depth: -1, role: '未知' },
        },
      },
    ]) {
      const parsed = parseCardJson(data)
      expect(parsed.fields.creator).toBe('')
      expect(parsed.fields.character_version).toBe('')
      expect(parsed.extras).toEqual({})
    }
  })
})
