import { Tiktoken } from 'js-tiktoken/lite'
import o200k_base from 'js-tiktoken/ranks/o200k_base'

/**
 * Token 计数。统一用 o200k_base 编码估算。
 * 非 OpenAI 模型会有偏差，组装时会再预留 5% 余量兜底。
 */

let encoder: Tiktoken | null = null

// 同样的文本只算一次。长对话里每次组装都要数一遍全部历史，缓存很重要
const cache = new Map<string, number>()
const CACHE_LIMIT = 20_000

export function countTokens(text: string): number {
  if (text === '') return 0
  const hit = cache.get(text)
  if (hit !== undefined) return hit

  encoder ??= new Tiktoken(o200k_base)
  const n = encoder.encode(text).length
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(text, n)
  return n
}

/** OpenAI 格式下每条消息除正文外的固定开销（角色标记等） */
export const MESSAGE_OVERHEAD_TOKENS = 4
