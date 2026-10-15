import { type CharacterFields, characterFieldsSchema } from '@ai-parter/shared'
import { isPng, readPngTextChunks } from './png'

export class CardParseError extends Error {}

export interface ParsedCard {
  spec: 'v1' | 'v2' | 'v3'
  fields: CharacterFields
  /** 卡里自带的世界书，原样保留，导入时再拆 */
  characterBook: unknown | null
  /** 导入时的整张卡，原样保存，保证导出不丢字段 */
  raw: Record<string, unknown>
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 只挑出字符串字段，类型不对的直接丢掉 */
function pickString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === 'string' ? v : undefined
}

function pickStringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const v = obj[key]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
}

/**
 * 把各版本的角色卡 JSON 统一成内部格式。
 * - V2 / V3：字段在 data 里，spec 为 chara_card_v2 / chara_card_v3
 * - V1：字段直接在顶层
 */
export function parseCardJson(json: unknown): ParsedCard {
  if (!isObject(json)) throw new CardParseError('角色卡内容不是 JSON 对象')

  let spec: ParsedCard['spec'] = 'v1'
  let data: Record<string, unknown> = json
  if (json.spec === 'chara_card_v3' || json.spec === 'chara_card_v2') {
    if (!isObject(json.data)) throw new CardParseError('角色卡缺少 data 字段')
    spec = json.spec === 'chara_card_v3' ? 'v3' : 'v2'
    data = json.data
  }

  const name = pickString(data, 'name') ?? pickString(json, 'name')
  if (!name?.trim()) throw new CardParseError('角色卡缺少名字')

  const result = characterFieldsSchema.safeParse({
    name,
    description: pickString(data, 'description'),
    personality: pickString(data, 'personality'),
    scenario: pickString(data, 'scenario'),
    first_mes: pickString(data, 'first_mes'),
    alternate_greetings: pickStringArray(data, 'alternate_greetings'),
    mes_example: pickString(data, 'mes_example'),
    system_prompt: pickString(data, 'system_prompt'),
    post_history_instructions: pickString(data, 'post_history_instructions'),
    creator_notes: pickString(data, 'creator_notes'),
    tags: pickStringArray(data, 'tags'),
  })
  if (!result.success) throw new CardParseError(`角色卡字段不合法：${result.error.message}`)

  const book = data.character_book
  return {
    spec,
    fields: result.data,
    characterBook: isObject(book) ? book : null,
    raw: json,
  }
}

/** 解析上传的文件：PNG 卡或 JSON 卡 */
export function parseCardFile(bytes: Uint8Array): ParsedCard {
  if (isPng(bytes)) {
    const chunks = readPngTextChunks(bytes)
    // 优先读 V3，没有再读 V2
    const encoded = chunks.get('ccv3') ?? chunks.get('chara')
    if (!encoded) throw new CardParseError('这张 PNG 里没有角色卡数据')
    try {
      const text = Buffer.from(encoded, 'base64').toString('utf8')
      return parseCardJson(JSON.parse(text))
    } catch (e) {
      if (e instanceof CardParseError) throw e
      throw new CardParseError('PNG 里的角色卡数据无法解析')
    }
  }

  try {
    return parseCardJson(JSON.parse(new TextDecoder().decode(bytes)))
  } catch (e) {
    if (e instanceof CardParseError) throw e
    throw new CardParseError('文件既不是 PNG 角色卡，也不是有效的 JSON')
  }
}
