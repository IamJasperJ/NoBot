import { describe, expect, test } from 'bun:test'
import { characterFieldsSchema } from '@ai-parter/shared'
import { buildPrompt, PromptBudgetError, type PromptContext } from './build'
import { applyMacros, rollDice, seededRandom } from './macros'

const now = new Date('2026-10-15T20:30:00+08:00')

function makeCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    character: characterFieldsSchema.parse({
      name: '艾莉丝',
      description: '{{char}}是一位魔法师。',
      personality: '温柔',
      mes_example: '<START>\n{{user}}: 你好\n{{char}}: 你好呀',
      post_history_instructions: '保持简短。',
    }),
    persona: { name: '旅人', description: '' },
    history: [
      { id: 'm1', role: 'assistant', content: '欢迎，{{user}}！' },
      { id: 'm2', role: 'user', content: '你是谁？' },
    ],
    api: { contextSize: 8192, maxTokens: 512 },
    chat: { id: 'c1', leafId: 'm2', authorNote: '', authorNoteDepth: 2 },
    now,
    ...overrides,
  }
}

describe('宏替换', () => {
  const ctx = { char: '艾莉丝', user: '旅人', now, seed: 's' }

  test('角色名、用户名和旧写法', () => {
    expect(applyMacros('{{char}}对{{ user }}说，<BOT>和<USER>', ctx)).toBe('艾莉丝对旅人说，艾莉丝和旅人')
  })

  test('注释被删除，未知宏原样保留', () => {
    expect(applyMacros('a{{// 备注}}b{{unknown}}', ctx)).toBe('ab{{unknown}}')
  })

  test('同一个种子随机结果相同', () => {
    const text = '{{random::甲::乙::丙::丁}} {{roll:1d100}}'
    expect(applyMacros(text, ctx)).toBe(applyMacros(text, ctx))
  })

  test('掷骰范围正确', () => {
    const random = seededRandom(42)
    for (let i = 0; i < 200; i++) {
      const r = rollDice('2d6+3', random) as number
      expect(r).toBeGreaterThanOrEqual(5)
      expect(r).toBeLessThanOrEqual(15)
    }
    expect(rollDice('abc', random)).toBeNull()
  })
})

describe('buildPrompt', () => {
  test('固定顺序：system 合并在前，历史在中间，历史后指令在最后', () => {
    const { messages } = buildPrompt(makeCtx())
    expect(messages.map((m) => m.role)).toEqual(['system', 'assistant', 'user', 'system'])
    expect(messages[0]?.content).toContain('艾莉丝是一位魔法师。')
    expect(messages[0]?.content).toContain('对话示例')
    expect(messages[1]?.content).toBe('欢迎，旅人！')
    expect(messages[3]?.content).toBe('保持简短。')
  })

  test('预算不够时从最旧的历史开始丢', () => {
    const history = Array.from({ length: 200 }, (_, i) => ({
      id: `m${i}`,
      role: (i % 2 === 0 ? 'assistant' : 'user') as 'assistant' | 'user',
      content: `第 ${i} 条消息，`.repeat(20),
    }))
    const { report } = buildPrompt(makeCtx({ history, api: { contextSize: 4096, maxTokens: 512 } }))
    expect(report.historyKept).toBeLessThan(200)
    expect(report.historyKept).toBeGreaterThan(0)
    expect(report.totalTokens).toBeLessThanOrEqual(report.budget)
    // 保留的一定是最新的那几条
    const kept = report.segments.filter((s) => s.source === 'history')
    expect(kept.at(-1)?.messageId).toBe('m199')
  })

  test('作者注释插在倒数第 depth 条之前', () => {
    const { report } = buildPrompt(
      makeCtx({ chat: { id: 'c1', leafId: 'm2', authorNote: '注意天气', authorNoteDepth: 1 } }),
    )
    const sources = report.segments.map((s) => s.source)
    const at = sources.indexOf('author_note')
    expect(sources[at - 1]).toBe('history')
    expect(report.segments[at + 1]?.messageId).toBe('m2')
  })

  test('固定部分超出预算时报错，不静默截断', () => {
    const ctx = makeCtx({ api: { contextSize: 600, maxTokens: 512 } })
    expect(() => buildPrompt(ctx)).toThrow(PromptBudgetError)
  })
})
