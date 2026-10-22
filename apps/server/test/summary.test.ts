import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countTokens } from '@nobot/core'
import type { CharacterDTO, ChatDTO, MessageMeta, MessageRole, PromptPreview, SummaryStateDTO } from '@nobot/shared'
import { eq } from 'drizzle-orm'
import { readSSE } from './helpers/sse'

test('剧情总结：素材、增量、注入、分支、自动、编辑、并发和失败', async () => {
  // 环境和数据库是模块单例，在子进程中使用独立数据库和模型边界。
  if (!process.env.SUMMARY_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', 'apps/server/test/summary.test.ts'], {
      env: { ...process.env, SUMMARY_TEST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const deadline = setTimeout(() => child.kill(), 25000)
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, `${out}\n${err}`).toBe(0)
    } finally {
      clearTimeout(deadline)
    }
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'nobot-summary-'))
  process.env.DATA_DIR = directory
  const { paths } = await import('../src/env')
  paths.db = ':memory:'
  const { bootstrap } = await import('../src/bootstrap')
  await bootstrap()
  const { db, sqlite, newId } = await import('../src/db/client')
  const { chats, messages, generationLogs, promptPresets } = await import('../src/db/schema')
  const { app } = await import('../src/app')
  const { loadMessage } = await import('../src/services/chats')
  const { createExtensionHost } = await import('../src/extensions/host')
  const { parseSettings } = await import('../src/extensions/builtin/summary/settings')
  const summaryExtension = (await import('../src/extensions/builtin/summary')).default
  const { assemble, loadGenerationContext } = await import('../src/services/generation/context')
  const requests: {
    messages: { role: string; content: string }[]
    stream: boolean
    max_tokens: number
    model: string
    tools?: unknown
  }[] = []
  let hold: Promise<void> | undefined
  let fail = false
  let empty = false
  let serial = 0
  const mocked = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const body = JSON.parse(String(init?.body)) as (typeof requests)[number]
        requests.push(body)
        const summary = body.messages.some((m) => m.content.includes('story chronicler'))
        if (summary && hold) await hold
        if (summary && fail) return Response.json({ error: { message: '模拟失败' } }, { status: 503 })
        return Response.json({
          choices: [
            {
              message: {
                role: 'assistant',
                content: summary ? (empty ? ' ' : `<think>隐藏思考</think>总结${++serial}`) : '普通生成回复',
              },
              finish_reason: 'stop',
            },
          ],
        })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  const request = (path: string, method = 'GET', body?: unknown) =>
    app.request(`/api${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
  async function json<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await request(path, method, body)
    const value: unknown = await response.json()
    expect(response.status, JSON.stringify(value)).toBe(200)
    return value as T
  }
  const settings = (value: Record<string, unknown>) =>
    json('/extensions/summary', 'PATCH', { settings: { auto: false, ...value } })
  const state = (chatId: string) => json<SummaryStateDTO>(`/ext/summary/state?chatId=${chatId}`)
  const run = (chatId: string) => json<SummaryStateDTO>('/ext/summary/run', 'POST', { chatId })
  const preview = (chatId: string) => json<PromptPreview>(`/chats/${chatId}/prompt-preview`, 'POST', {})
  async function error(path: string, status: number, code: string, body?: unknown, method = 'POST') {
    const response = await request(path, method, body)
    expect(response.status).toBe(status)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code)
  }
  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 3000
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('等待总结超时')
      await Bun.sleep(10)
    }
  }
  try {
    expect(parseSettings({ interval: -1, words: '错', keepRecent: 2 }).interval).toBe(20)
    expect(parseSettings({ interval: -1, words: '错', keepRecent: 2 }).keepRecent).toBe(2)
    const character = await json<CharacterDTO>('/characters', 'POST', { name: '角色甲', firstMes: '' })
    await json('/connections', 'POST', {
      name: '模拟',
      baseUrl: 'http://mock.test/v1',
      model: 'test-model',
      apiKey: '',
    })
    const create = () => json<ChatDTO>('/chats', 'POST', { characterId: character.id })
    function add(
      chatId: string,
      parentId: string | null,
      role: MessageRole,
      content: string,
      meta: MessageMeta = {},
      status: 'done' | 'error' | 'aborted' = 'done',
    ) {
      const id = newId()
      db.insert(messages)
        .values({
          id,
          chatId,
          parentId,
          role,
          content,
          meta,
          status,
          speakerId: role === 'assistant' ? character.id : null,
          createdAt: Date.now(),
        })
        .run()
      db.update(chats).set({ activeLeafId: id }).where(eq(chats.id, chatId)).run()
      return id
    }
    const chat = await create()
    const a = add(chat.id, null, 'user', '出发')
    const b = add(chat.id, a, 'assistant', '<scene>酒馆</scene>\n角色甲: 你好', {}, 'aborted')
    const excluded = add(chat.id, b, 'user', '排除', { excluded: true })
    const failed = add(chat.id, excluded, 'assistant', '失败', {}, 'error')
    const image = add(chat.id, failed, 'user', '', { images: [{ id: 'image', url: '', width: 1, height: 1 }] })
    const last = add(chat.id, image, 'assistant', '最后一条')
    await error(`/ext/summary/state?chatId=${chat.id}`, 404, 'NOT_FOUND', undefined, 'GET')
    await json('/extensions/summary', 'PATCH', { enabled: true, settings: { auto: false } })
    let result = await state(chat.id)
    expect(result.current).toBeNull()
    expect(result.pending.messages).toBe(2)
    result = await run(chat.id)
    expect(result.current?.messageId).toBe(b)
    expect(result.current?.coveredCount).toBe(2)
    expect(result.current?.auto).toBe(false)
    const body = requests.at(-1)!
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(body.messages[0]?.content).toContain('300 words or Chinese characters')
    expect(body.messages[0]?.content).toContain('Write in the same language as the conversation.')
    expect(body.messages[1]?.content).toContain('[Existing summary]\n(none)')
    expect(body.messages[1]?.content).toContain('[New conversation]')
    expect(body.messages[1]?.content).toContain('旅人：出发')
    expect(body.messages[1]?.content).toContain('角色甲：')
    expect(body.messages[1]?.content).not.toContain('<scene>')
    expect(body.messages[1]?.content).not.toContain('排除')
    expect(body.stream).toBe(false)
    expect(body.tools).toBeUndefined()
    expect(body.model).toBe('test-model')
    expect(body.max_tokens).toBe(600)
    expect(result.current?.text).toBe('总结1')
    const c = add(chat.id, last, 'user', '增量消息')
    const d = add(chat.id, c, 'assistant', '后续末尾')
    result = await run(chat.id)
    expect(result.current?.messageId).toBe(c)
    expect(result.current?.coveredCount).toBe(2)
    expect(result.history[0]?.messageId).toBe(b)
    expect(requests.at(-1)?.messages[1]?.content).toContain('[Existing summary]\n总结1')
    expect(requests.at(-1)?.messages[1]?.content).not.toContain('旅人：出发')
    const oldTime = result.current!.createdAt
    await json('/ext/summary/entry', 'PATCH', { chatId: chat.id, messageId: c, text: '自定义总结' })
    expect((await state(chat.id)).current).toMatchObject({
      text: '自定义总结',
      createdAt: oldTime,
      auto: false,
      coveredCount: 2,
    })
    let prompt = await preview(chat.id)
    expect(prompt.messages.some((m) => m.content.includes('[Story summary: 自定义总结]'))).toBe(true)
    expect(prompt.report.segments.some((s) => s.source === 'summary')).toBe(true)
    await settings({ position: 'depth', depth: 1, role: 'user', template: '记忆{{summary}}' })
    prompt = await preview(chat.id)
    expect(prompt.messages.some((m) => m.role === 'user' && m.content.includes('记忆自定义总结'))).toBe(true)
    const sources = prompt.report.segments.map((s) => s.source)
    expect(sources.at(-2)).toBe('summary')
    await settings({ position: 'author_note', template: '作者记忆{{summary}}' })
    expect((await preview(chat.id)).messages.some((m) => m.content.includes('作者记忆自定义总结'))).toBe(true)
    await settings({ skipSummarized: true, keepRecent: 1 })
    prompt = await preview(chat.id)
    expect(prompt.messages.some((m) => m.content.includes('出发'))).toBe(false)
    expect(prompt.messages.some((m) => m.content.includes('增量消息'))).toBe(false)
    expect(prompt.messages.some((m) => m.content.includes('后续末尾'))).toBe(true)
    // swipe 到没有最新总结的同级分支，回到较早的一份。
    const alternate = add(chat.id, last, 'user', '另一条路')
    await json(`/chats/${chat.id}/swipe`, 'POST', { messageId: alternate, direction: -1 })
    expect((await state(chat.id)).current?.messageId).toBe(c)
    await json(`/chats/${chat.id}/swipe`, 'POST', { messageId: c, direction: 1 })
    expect((await state(chat.id)).current?.messageId).toBe(b)
    expect((await preview(chat.id)).messages.some((m) => m.content.includes('[Story summary: 总结1]'))).toBe(true)
    await json('/ext/summary/entry', 'DELETE', { chatId: chat.id, messageId: b })
    expect((await state(chat.id)).current).toBeNull()
    const other = await create()
    await error('/ext/summary/entry', 404, 'NOT_FOUND', { chatId: other.id, messageId: c, text: '错会话' }, 'PATCH')
    await error('/ext/summary/entry', 404, 'NOT_FOUND', { chatId: chat.id, messageId: a }, 'DELETE')
    await error('/ext/summary/run', 404, 'NOT_FOUND', { chatId: 'missing' })
    await error('/ext/summary/run', 400, 'NOTHING_TO_SUMMARIZE', { chatId: other.id })
    await error('/ext/summary/entry', 400, 'BAD_REQUEST', { chatId: chat.id, messageId: c, text: ' ' }, 'PATCH')

    // 锁在第一次 await 前取得；结果写回时若目标已删，则直接丢弃。
    await settings({})
    let release = () => {}
    hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = run(chat.id)
    await until(async () => (await state(chat.id)).running)
    await error('/ext/summary/run', 409, 'BUSY', { chatId: chat.id })
    release()
    await pending
    hold = undefined
    const e = add(chat.id, alternate, 'user', '待删素材')
    add(chat.id, e, 'assistant', '等待')
    hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const deleting = run(chat.id)
    await until(async () => (await state(chat.id)).running)
    db.delete(messages).where(eq(messages.id, e)).run()
    db.update(chats).set({ activeLeafId: alternate }).where(eq(chats.id, chat.id)).run()
    release()
    await deleting
    hold = undefined
    expect((await state(chat.id)).running).toBe(false)

    // 空结果视为失败，日志和 lastError 可见，下次成功清空错误。
    const f = add(chat.id, alternate, 'user', '失败后重试素材')
    add(chat.id, f, 'assistant', '末尾')
    empty = true
    expect((await run(chat.id)).lastError).toBe('模型返回了空总结')
    expect(
      db
        .select()
        .from(generationLogs)
        .all()
        .some((l) => l.status === 'error' && l.kind === 'extension'),
    ).toBe(true)
    empty = false
    fail = true
    expect((await run(chat.id)).lastError).toBeTruthy()
    fail = false
    expect((await run(chat.id)).lastError).toBeNull()

    // 条数与 token 预算都优先保留前面的消息，至少带一条。
    const limited = await create()
    const l1 = add(limited.id, null, 'user', '一'.repeat(1000))
    const l2 = add(limited.id, l1, 'assistant', '第二条')
    add(limited.id, l2, 'user', '末条')
    await settings({ maxTokens: 16000, words: 50 })
    result = await run(limited.id)
    expect(result.current).toMatchObject({ messageId: l1, coveredCount: 1 })
    expect(result.pending.tokens).toBe(countTokens('角色甲：第二条'))
    await settings({ mode: 'full', maxTokens: 123, model: 'override' })
    result = await run(limited.id)
    expect(result.current?.messageId).toBe(l2)
    expect(requests.at(-1)?.messages.length).toBeGreaterThan(2)
    expect(requests.at(-1)?.max_tokens).toBe(123)
    expect(requests.at(-1)?.model).toBe('override')

    const capped = await create()
    const cap1 = add(capped.id, null, 'user', '第一条素材')
    const cap2 = add(capped.id, cap1, 'assistant', '第二条素材')
    add(capped.id, cap2, 'user', '保留末条')
    await settings({ maxMessages: 1 })
    expect((await run(capped.id)).current).toMatchObject({ messageId: cap1, coveredCount: 1 })
    expect((await state(capped.id)).pending.messages).toBe(1)
    expect(requests.at(-1)?.messages[1]?.content).not.toContain('第二条素材')

    // 工具调用和结果一起过滤，keepRecent 落在结果上也跟随调用者。
    const tools = await create()
    const call = add(tools.id, null, 'assistant', '调用正文', {
      toolCalls: [{ id: 'call', name: 'search', arguments: '{}' }],
      summary: { text: '工具总结', createdAt: 1, auto: false, coveredCount: 1 },
    })
    const tool = add(tools.id, call, 'tool', '结果', { toolCallId: 'call' })
    const input = assemble(loadGenerationContext(tools.id, { requireConnection: false }), {
      type: 'normal',
      speakerId: character.id,
      leafId: tool,
    }).input
    const host = createExtensionHost(() => {})
    const context = {
      host,
      chatId: tools.id,
      storage: { get: () => undefined, set: () => {}, delete: () => {} },
      settings: { skipSummarized: true, keepRecent: 1 },
    }
    expect(summaryExtension.hooks!.beforePrompt!(input, context).history).toEqual([])
    context.settings.keepRecent = 2
    expect(summaryExtension.hooks!.beforePrompt!(input, context).history.map((m) => m.id)).toEqual([call, tool])

    await settings({ auto: true, interval: 2 })
    const automatic = await create()
    // 让真实生成流程发送非流式模型请求，仍通过 SSE 接口验收事件。
    for (const row of db.select().from(promptPresets).all()) {
      db.update(promptPresets)
        .set({ data: { ...row.data, samplers: { ...row.data.samplers, stream: false } } })
        .where(eq(promptPresets.id, row.id))
        .run()
    }
    for (let i = 0; i < 2; i++)
      await readSSE(await request(`/chats/${automatic.id}/generate`, 'POST', { mode: 'send', text: `第${i}轮` }))
    await until(async () => (await state(automatic.id)).current?.auto === true)
    const frozen = await json<SummaryStateDTO>('/ext/summary/freeze', 'POST', { chatId: automatic.id, frozen: true })
    expect(frozen.frozen).toBe(true)
    for (let i = 0; i < 2; i++)
      await readSSE(await request(`/chats/${automatic.id}/generate`, 'POST', { mode: 'send', text: `暂停${i}` }))
    await Bun.sleep(30)
    expect((await state(automatic.id)).current?.messageId).toBe(frozen.current?.messageId)
    expect((await state(automatic.id)).pending.messages).toBeGreaterThanOrEqual(2)
    await json('/ext/summary/freeze', 'POST', { chatId: automatic.id, frozen: false })
    await settings({ auto: true, interval: 0, tokenThreshold: 1 })
    await readSSE(await request(`/chats/${automatic.id}/generate`, 'POST', { mode: 'send', text: 'token触发' }))
    await until(async () => (await state(automatic.id)).current?.messageId !== frozen.current?.messageId)
    expect(loadMessage(d).meta.summary).toBeUndefined()
  } finally {
    mocked.mockRestore()
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
