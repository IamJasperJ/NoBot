import { expect, test } from 'bun:test'
import { presetDataSchema } from '@nobot/shared'
import { DEFAULT_MAIN_PROMPT_EN, DEFAULT_UTILITY_PROMPTS_EN, parsePresetWithEnglishDefaults } from './defaults'

test('英文默认值补齐缺失字段，保留已存储和用户提供的文字', () => {
  const defaults = parsePresetWithEnglishDefaults({})
  expect(defaults.prompts.find((p) => p.id === 'main')?.content).toBe(DEFAULT_MAIN_PROMPT_EN)
  expect(defaults.utility).toEqual(DEFAULT_UTILITY_PROMPTS_EN)
  for (const key of ['groupNudge', 'continueNudge', 'impersonation'] as const)
    expect(defaults.utility[key]).toContain('Write in the same language as the conversation.')
  expect(DEFAULT_MAIN_PROMPT_EN).toContain('Write in the same language as the conversation.')
  expect(parsePresetWithEnglishDefaults({ utility: { newChat: '用户自定义开场' } }).utility).toEqual({
    ...DEFAULT_UTILITY_PROMPTS_EN,
    newChat: '用户自定义开场',
  })
  const stored = presetDataSchema.parse({})
  expect(parsePresetWithEnglishDefaults(stored)).toEqual(stored)
})
