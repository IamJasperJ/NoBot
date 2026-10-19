/// <reference types="bun" />
import { describe, expect, test } from 'bun:test'
import { defaultPromptBlocks } from '@nobot/shared'
import { isExtraBodyValid, movePrompt } from './presetEditor'

describe('额外请求参数校验', () => {
  test('允许空白和 JSON 对象', () => {
    for (const value of ['', '  \n', '{}', '{"provider":{"order":["DeepSeek"]}}']) {
      expect(isExtraBodyValid(value)).toBe(true)
    }
  })
  test('拒绝不完整 JSON、数组、null 和基础类型', () => {
    for (const value of ['{', '{"provider":}', '[]', 'null', '"text"', '1', 'true']) {
      expect(isExtraBodyValid(value)).toBe(false)
    }
  })
})

describe('Prompt 顺序', () => {
  test('向下和向上移动均保持条目内容、深度和原数组不变', () => {
    const blocks = defaultPromptBlocks()
    blocks[0] = { ...blocks[0]!, position: 'in_chat', depth: 7, order: 20 }
    const original = structuredClone(blocks)
    const first = blocks[0]!
    const moved = movePrompt(blocks, first.id, blocks.length - 1)
    expect(moved.at(-1)).toEqual(first)
    expect(moved.slice(0, -1)).toEqual(blocks.slice(1))
    expect(movePrompt(moved, first.id, 0)).toEqual(blocks)
    expect(blocks).toEqual(original)
  })
  test('越界、找不到条目或原位置均不改变顺序', () => {
    const blocks = defaultPromptBlocks()
    expect(movePrompt(blocks, '不存在', 0)).toBe(blocks)
    expect(movePrompt(blocks, blocks[0]!.id, -1)).toBe(blocks)
    expect(movePrompt(blocks, blocks[0]!.id, blocks.length)).toBe(blocks)
    expect(movePrompt(blocks, blocks[0]!.id, 0)).toBe(blocks)
  })
})
