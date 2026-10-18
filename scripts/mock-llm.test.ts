import { expect, spyOn, test } from 'bun:test'
import { parseStageMessage } from '../packages/core/src/stage'

test('模拟 VN 回复在首句台词后插入 CG，流式与非流式内容一致', async () => {
  // 捕获真实脚本的处理器，沙箱中无需监听端口也能验证开发用回复。
  let respond!: (request: Request) => Promise<Response>
  const serve = spyOn(Bun, 'serve').mockImplementation(((options: { fetch: typeof respond }) => {
    respond = options.fetch
    return {} as ReturnType<typeof Bun.serve>
  }) as typeof Bun.serve)
  const log = spyOn(console, 'log').mockImplementation(() => {})
  try {
    await import('./mock-llm')
  } finally {
    serve.mockRestore()
    log.mockRestore()
  }
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
