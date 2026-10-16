// 开发用的模拟模型：OpenAI 兼容接口（/v1/models、/v1/chat/completions，支持流式、非流式、工具调用）
// 用法：bun scripts/mock-llm.ts  （端口 3999；连接里填 http://127.0.0.1:3999/v1，Key 填 sk-test）
// 规则：请求带 tools 且最后一条用户消息含「掷骰」、还没有工具结果时，返回一次 roll_dice 调用
Bun.serve({
  port: Number(process.env.PORT ?? 3999),
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/v1/models') {
      if (req.headers.get('authorization') !== 'Bearer sk-test')
        return Response.json({ error: { message: 'bad key' } }, { status: 401 })
      return Response.json({ data: [{ id: 'mock-b' }, { id: 'mock-a' }] })
    }
    if (url.pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 })
    const body = await req.json()
    await Bun.write(process.env.LAST_REQ ?? '/dev/null', JSON.stringify(body, null, 2))
    const msgs: any[] = body.messages
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? ''
    const hasToolResult = msgs.some((m) => m.role === 'tool')
    const wantTool = body.tools && String(lastUser).includes('掷骰') && !hasToolResult
    const _last = msgs.at(-1)
    const reply = hasToolResult
      ? `根据掷骰结果「${msgs.filter((m) => m.role === 'tool').at(-1).content}」，你成功了。`
      : `你好！这是模拟回复，你刚才说的是「${String(lastUser).slice(0, 20)}」。`
    const enc = new TextEncoder()
    if (!body.stream) {
      return Response.json({
        choices: [
          wantTool
            ? {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'roll_dice', arguments: '{"expression":"1d20","reason":"潜行检定"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              }
            : { message: { role: 'assistant', content: reply }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      })
    }
    const stream = new ReadableStream({
      async start(ctrl) {
        const send = (o: unknown) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`))
        if (wantTool) {
          send({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', type: 'function', function: { name: 'roll_dice', arguments: '' } },
                  ],
                },
              },
            ],
          })
          send({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"expression":"1d20",' } }] } }],
          })
          send({
            choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"reason":"潜行检定"}' } }] } }],
          })
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
        } else {
          send({ choices: [{ delta: { reasoning_content: '思考中…' } }] })
          for (const w of reply.split('')) {
            send({ choices: [{ delta: { content: w } }] })
            await Bun.sleep(Number(process.env.DELAY ?? 20))
          }
          send({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: reply.length },
          })
        }
        ctrl.enqueue(enc.encode('data: [DONE]\n\n'))
        ctrl.close()
      },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  },
})
console.log('mock llm on 3999')
