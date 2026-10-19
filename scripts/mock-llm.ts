// 开发用的模拟模型：OpenAI 兼容接口（/v1/models、/v1/chat/completions，支持流式、非流式、工具调用）
// 图片：POST /v1/images/generations，延迟 1.5 秒返回 64×64 PNG；提示词含 FAIL 时返回 500
// ComfyUI：POST /prompt、GET /history/<id>、GET /view、GET /object_info/CheckpointLoaderSimple（路径不加 /v1）
// 用法：bun scripts/mock-llm.ts  （端口 3999；连接里填 http://127.0.0.1:3999/v1，Key 填 sk-test）
// 规则：最后一条消息是背景起名请求（Output only JSON: {"name"…）时，回答固定的 {"name":"模拟背景",…}；
//      system 提示词是情绪判断（含 following labels:）时，回答被判断消息里出现的标签；
//      最后一条用户消息含「VN」时，回复一段带舞台指令（场景、上台、台词速记、<state>、<choices>）的内容，
//      说话人固定是「艾莉丝」；
//      请求带 tools 且最后一条用户消息含「掷骰」、还没有工具结果时，返回一次 roll_dice 调用；
//      含「检定」且提供 ability_check 工具、没有工具结果时，返回玩家隐匿 DC13 检定；
//      含「结束战斗」「下一回合」「战斗」时分别回复结束、推进、开始战斗指令及旁白；
//      系统或用户消息含 translate / Translate 翻译指令时，回复「[译] 」加原文，保留全部标记；
//      含「画图」且提供了 generate_image 工具时，返回一次 generate_image 调用
// 64×64 纯色 PNG（直接内嵌，模拟服务不依赖 sharp）
const mockPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAn0lEQVRoge2SQQkAQRDDqr2aTk+0rIh7hIFCBKSh6cdpoht0A9ArdhfiLtENugHoFbsLcZfoBt0A9IrdhbhLdINuAHrF7kLcJbpBNwC9Ynch7hLdoBuAXrG7EHeJbtANQK/YXYi7RDfoBqBX7C7EXaIbdAPQK3YX4i7RDboB6BW7C3GX6AbdAPSK3YW4S3SDbgB6xe5C3CW6QTcAveIfHnL/QfDXJAFrAAAAAElFTkSuQmCC',
  'base64',
)
const imageJobs = new Map<string, number>()
Bun.serve({
  port: Number(process.env.PORT ?? 3999),
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === 'POST' && url.pathname === '/v1/images/generations') {
      const body = (await req.json()) as { prompt?: string }
      await Bun.sleep(1500)
      if (body.prompt?.includes('FAIL'))
        return Response.json({ error: { message: '模拟的图片接口错误' } }, { status: 500 })
      return Response.json({ data: [{ b64_json: mockPng.toString('base64') }] })
    }
    if (req.method === 'POST' && url.pathname === '/prompt') {
      const prompt_id = crypto.randomUUID()
      imageJobs.set(prompt_id, Date.now())
      setTimeout(() => imageJobs.delete(prompt_id), 600000).unref()
      return Response.json({ prompt_id })
    }
    if (url.pathname.startsWith('/history/')) {
      const id = url.pathname.slice('/history/'.length)
      const started = imageJobs.get(id)
      return Response.json(
        started !== undefined && Date.now() - started >= 1500
          ? { [id]: { outputs: { '9': { images: [{ filename: 'mock.png', subfolder: '', type: 'output' }] } } } }
          : {},
      )
    }
    if (url.pathname === '/view') return new Response(mockPng, { headers: { 'Content-Type': 'image/png' } })
    if (url.pathname === '/system_stats') return Response.json({ system: { os: 'mock' } })
    if (url.pathname === '/object_info' || url.pathname.startsWith('/object_info/')) {
      const nodes = {
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [['mock_a.safetensors', 'mock_b.safetensors']] } } },
        UNETLoader: { input: { required: { unet_name: [['flux_dev.safetensors']] } } },
        UnetLoaderGGUF: { input: { required: { unet_name: [['flux_dev.gguf']] } } },
        KSampler: {
          input: { required: { sampler_name: [['euler', 'euler_ancestral']], scheduler: [['normal', 'karras']] } },
        },
        VAELoader: { input: { required: { vae_name: [['ae.safetensors']] } } },
      }
      const name = url.pathname.split('/')[2] as keyof typeof nodes | undefined
      return Response.json(name ? { [name]: nodes[name] } : nodes)
    }
    if (url.pathname === '/v1/models') {
      if (req.headers.get('authorization') !== 'Bearer sk-test')
        return Response.json({ error: { message: 'bad key' } }, { status: 401 })
      return Response.json({ data: [{ id: 'mock-b' }, { id: 'mock-a' }, { id: 'gpt-image-1' }, { id: 'flux-dev' }] })
    }
    if (url.pathname !== '/v1/chat/completions') return new Response('not found', { status: 404 })
    const body = await req.json()
    await Bun.write(process.env.LAST_REQ ?? '/dev/null', JSON.stringify(body, null, 2))
    const msgs: any[] = body.messages
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? ''
    const hasToolResult = msgs.some((m) => m.role === 'tool')
    const toolNames: string[] = (body.tools ?? []).map((t: any) => t.function?.name)
    const toolCall = hasToolResult
      ? null
      : String(lastUser).includes('掷骰') && toolNames.includes('roll_dice')
        ? { name: 'roll_dice', arguments: '{"expression":"1d20","reason":"潜行检定"}' }
        : String(lastUser).includes('检定') && toolNames.includes('ability_check')
          ? { name: 'ability_check', arguments: '{"who":"player","skill":"stealth","dc":13}' }
          : String(lastUser).includes('画图') && toolNames.includes('generate_image')
            ? {
                name: 'generate_image',
                arguments: '{"prompt":"1girl, cozy cafe, sunset light","orientation":"portrait"}',
              }
            : null
    const wantTool = !!toolCall
    const _last = msgs.at(-1)
    const vnReply = [
      '<scene bg="公会大厅" place="冒险者公会" time="傍晚" />',
      '<show who="艾莉丝" at="left" />',
      '公会里人声鼎沸，冒险者们围着任务板讨论着今天的委托。',
      '艾莉丝[joy]：「你终于来啦！我还以为你忘了今天的约定呢。」',
      '<cg prompt="1girl, tavern, warm light, smiling" />',
      '她把一杯热麦酒推到你面前，耳尖却悄悄红了。',
      '艾莉丝[embarrassment]：「……才、才不是特意等你的！」',
      '<state>',
      'affection += 3',
      'time = "傍晚"',
      '</state>',
      '<choices>',
      '- 笑着接过麦酒，坐到她身边',
      '- 打趣她「明明就是在等我」',
      '- [察觉 DC12] 留意角落里那个披着斗篷的人',
      '</choices>',
    ].join('\n')
    // 情绪判断请求（酒馆默认提示词）：从被判断的消息里找出现的标签作答，找不到就答第一个标签
    const classifyLabels = String(msgs[0]?.content ?? '')
      .match(/following labels:\s*(.+)$/)?.[1]
      ?.split(/,\s*/)
      .filter(Boolean)
    const classifyAnswer = classifyLabels
      ? (classifyLabels.find((label) => String(lastUser).toLowerCase().includes(label)) ?? classifyLabels[0])
      : null
    // 背景起名请求：回答固定的 JSON
    const nameRequest = String(msgs.at(-1)?.content ?? '').includes('Output only JSON: {"name"')
    const summaryRequest =
      msgs.some((m) => m.role === 'system' && String(m.content).includes('story chronicler')) ||
      String(msgs.at(-1)?.content).includes('[New conversation]')
    const summaryMessage = String(msgs.at(-1)?.content ?? '')
    const summaryIndex = summaryMessage.indexOf('[New conversation]')
    const summaryText =
      summaryIndex < 0
        ? '（无）'
        : Array.from(summaryMessage.slice(summaryIndex + '[New conversation]'.length))
            .slice(0, 30)
            .join('')
    // 翻译优先于剧情触发，避免原文里的触发词改变译文和舞台标记。
    const translationRequest = msgs.some(
      (m) => ['system', 'user'].includes(m.role) && /\btranslate\b/i.test(String(m.content)),
    )
    const combatReply = String(lastUser).includes('结束战斗')
      ? '<combat end> 战斗结束，公会恢复了平静。'
      : String(lastUser).includes('下一回合')
        ? '<combat next> 下一位行动者准备出手。'
        : String(lastUser).includes('战斗')
          ? '<combat start: 艾莉丝, 哥布林> 哥布林冲入大厅，艾莉丝拔剑迎战。'
          : null
    const reply = translationRequest
      ? `[译] ${String(lastUser)}`
      : summaryRequest
        ? `模拟总结：${summaryText}`
        : nameRequest
          ? '{"name": "模拟背景", "description": "模拟模型写的画面描述"}'
          : classifyAnswer
            ? classifyAnswer
            : hasToolResult
              ? `根据工具结果「${msgs.filter((m) => m.role === 'tool').at(-1).content}」，继续故事。`
              : combatReply
                ? combatReply
                : String(lastUser).includes('VN')
                  ? vnReply
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
                      function: toolCall,
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
          const args = toolCall?.arguments ?? ''
          const half = Math.floor(args.length / 2)
          send({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_1', type: 'function', function: { name: toolCall?.name, arguments: '' } },
                  ],
                },
              },
            ],
          })
          send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] } }] })
          send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] } }] })
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
