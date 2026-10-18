import { expect, test } from 'bun:test'
import { imageDescriptions, supportsVision } from './vision'

test('视觉型号自动识别与显式覆盖', () => {
  for (const model of [
    'gpt-4o-mini',
    'openai/gpt-4.1',
    'gpt-5',
    'gpt-5.2',
    'claude-3-haiku',
    'claude-sonnet-4-5',
    'gemini-2.5-pro',
    'qwen2.5-vl-72b',
    'llava',
    'pixtral-12b',
    'glm-4v',
  ])
    expect(supportsVision(model), model).toBe(true)
  for (const model of ['gpt-4', 'gpt-3.5-turbo', 'claude-2', 'qwen3-32b', 'deepseek-chat', ''])
    expect(supportsVision(model), model).toBe(false)
  expect(supportsVision('gpt-4o', 'no')).toBe(false)
  expect(supportsVision('custom', 'yes')).toBe(true)
})

test('图片描述保留顺序与缺失占位', () => {
  expect(imageDescriptions([{ caption: '猫' }, {}, { caption: ' ' }, { caption: ' dog ' }])).toBe(
    '[Image: 猫]\n[Image]\n[Image]\n[Image: dog]',
  )
})
