import { expect, test } from 'bun:test'
import { parseStageMessage } from '../packages/core/src/stage'

test('模拟 VN 回复在首句台词后插入 CG，流式与非流式内容一致', async () => {
  // 直接复用服务处理器，沙箱中无需监听端口。
  const { mockLlmFetch: respond } = await import('./mock-llm')
  const previousDelay = process.env.DELAY
  process.env.DELAY = '0'
  const request = (stream: boolean) =>
    respond(
      new Request('http://mock/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'VN' }], stream }),
      }),
    )
  try {
    const json = (await (await request(false)).json()) as { choices: { message: { content: string } }[] }
    const content = json.choices[0]!.message.content
    expect(content).toContain(
      '来啦！我还以为你忘了今天的约定呢。」\n<cg prompt="1girl, tavern, warm light, smiling" />',
    )
    const parsed = parseStageMessage(content, { knownNames: ['艾莉丝'] })
    expect(parsed.stage.beats.map((beat) => beat.kind)).toEqual([
      'stage',
      'narration',
      'line',
      'cg',
      'narration',
      'line',
      'choices',
    ])
    expect(parsed.stage.beats[3]).toEqual({ kind: 'cg', prompt: '1girl, tavern, warm light, smiling' })
    const events = (await (await request(true)).text()).split('\n')
    const streamed = events
      .flatMap((line) => {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') return []
        const event = JSON.parse(line.slice(6)) as { choices: { delta: { content?: string } }[] }
        return [event.choices[0]?.delta.content ?? '']
      })
      .join('')
    expect(streamed).toBe(content)
  } finally {
    if (previousDelay === undefined) delete process.env.DELAY
    else process.env.DELAY = previousDelay
  }
})

test('模拟贴纸工具只在 STICKER 且工具可用且尚无结果时触发', async () => {
  const { mockLlmFetch } = await import('./mock-llm')
  const request = (tools: string[], toolResult = false) =>
    mockLlmFetch(
      new Request('http://mock/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stream: false,
          messages: [
            { role: 'user', content: 'STICKER' },
            ...(toolResult ? [{ role: 'tool', content: 'queued' }] : []),
          ],
          tools: tools.map((name) => ({ type: 'function', function: { name } })),
        }),
      }),
    )
  const response = (await (await request(['send_sticker'])).json()) as {
    choices: { message: { tool_calls: { function: { name: string; arguments: string } }[] } }[]
  }
  expect(response.choices[0]?.message.tool_calls[0]?.function).toEqual({
    name: 'send_sticker',
    arguments: '{"mood":"😏"}',
  })
  for (const [tools, result] of [
    [[], false],
    [['send_sticker'], true],
  ] as const) {
    const body = (await (await request([...tools], result)).json()) as {
      choices: { message: { tool_calls?: unknown[] } }[]
    }
    expect(body.choices[0]?.message.tool_calls).toBeUndefined()
  }
})

test('模拟语音工具只在当前回复尚无工具结果且支持 send_voice 时触发', async () => {
  const { mockLlmFetch } = await import('./mock-llm')
  for (const [available, done, expected] of [
    [true, false, true],
    [false, false, false],
    [true, true, false],
  ] as const) {
    const response = await mockLlmFetch(
      new Request('http://mock/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stream: false,
          messages: [
            { role: 'tool', content: 'previous turn' },
            { role: 'user', content: 'VOICEPLEASE' },
            ...(done ? [{ role: 'tool', content: 'queued' }] : []),
          ],
          tools: available ? [{ type: 'function', function: { name: 'send_voice' } }] : [],
        }),
      }),
    )
    const body = (await response.json()) as {
      choices: { message: { tool_calls?: { function: { name: string } }[] } }[]
    }
    expect(body.choices[0]?.message.tool_calls?.[0]?.function.name === 'send_voice').toBe(expected)
  }
})
