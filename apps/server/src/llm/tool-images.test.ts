import { expect, test } from 'bun:test'
import { samplerSchema } from '@nobot/shared'
import { buildRequestBody } from './body'
import { anthropicBody } from './providers/anthropic'
import { googleBody } from './providers/google'
import { openaiBody } from './providers/openai'

const image = 'data:image/png;base64,aGVsbG8='
const body = () =>
  buildRequestBody({
    model: 'gemini-2.5-pro',
    samplers: samplerSchema.parse({ inlineImages: true }),
    images: new Map([['a', image]]),
    messages: [
      { role: 'user', content: 'look' },
      {
        role: 'assistant',
        content: '',
        tool_calls: ['one', 'two'].map((id) => ({ id, type: 'function', function: { name: id, arguments: '{}' } })),
      },
      { role: 'tool', content: 'first', tool_call_id: 'one', images: ['a'] },
      { role: 'tool', content: 'second', tool_call_id: 'two', images: ['a'] },
      { role: 'assistant', content: 'done' },
    ],
  })

test('OpenAI 所有工具结果连续排列，图片在最后一个结果后补发，Azure 也共用此映射', () => {
  for (const provider of ['openai', 'custom', 'azure', 'openrouter']) {
    const messages = openaiBody(body(), provider).messages as Record<string, unknown>[]
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user', 'assistant'])
    expect(messages[2]?.content).toBe('first')
    expect(messages[3]?.content).toBe('second')
    expect(messages[4]?.content).toEqual([
      { type: 'text', text: 'Images returned by tool one:' },
      { type: 'image_url', image_url: { url: image, detail: 'auto' } },
      { type: 'text', text: 'Images returned by tool two:' },
      { type: 'image_url', image_url: { url: image, detail: 'auto' } },
    ])
  }
})

test('Claude 的每个 tool_result 原生携带图片，Gemini/Vertex 保持函数结果顺序后补 inline_data', () => {
  const claude = anthropicBody(body())
  const results = claude.messages[2].content
  expect(results).toHaveLength(2)
  expect(results[0]).toMatchObject({
    type: 'tool_result',
    tool_use_id: 'one',
    content: [
      { type: 'text', text: 'first' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
    ],
  })
  for (const vertex of [false, true]) {
    const google = googleBody(body(), vertex)
    const parts = google.contents[2].parts
    expect(parts.slice(0, 2).map((p: { functionResponse: { name: string } }) => p.functionResponse.name)).toEqual([
      'one',
      'two',
    ])
    expect(parts[3]).toEqual({ inline_data: { mime_type: 'image/png', data: 'aGVsbG8=' } })
  }
})
