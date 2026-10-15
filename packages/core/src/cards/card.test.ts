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
    const once = writePngTextChunks(TINY_PNG, { chara: toBase64({ name: 'a' }) })
    const twice = writePngTextChunks(once, { chara: toBase64({ name: 'b' }) })
    expect(readPngTextChunks(twice).size).toBe(1)
    expect(parseCardFile(twice).fields.name).toBe('b')
  })

  test('没有角色卡数据的 PNG 报错', () => {
    expect(() => parseCardFile(TINY_PNG)).toThrow('没有角色卡数据')
  })

  test('JSON 文件也能导入', () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ name: 'JSON 角色' }))
    expect(parseCardFile(bytes).fields.name).toBe('JSON 角色')
  })
})
