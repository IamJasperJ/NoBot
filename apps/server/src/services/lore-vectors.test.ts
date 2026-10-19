import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ApiPresetDTO,
  CharacterDTO,
  ChatDTO,
  LorebookDTO,
  LorebookEntryDTO,
  PromptPreview,
  WorldInfoSettings,
} from '@nobot/shared'

test('世界书服务集成：向量缓存、扫描设置、消息树定时效果及生成元数据', async () => {
  // 数据库和注册表是单例，独立进程避免污染其他服务测试。
  if (!process.env.LORE_TEST_CHILD) {
    const directory = await mkdtemp(join(tmpdir(), 'nobot-lore-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        env: { ...process.env, LORE_TEST_CHILD: '1', DATA_DIR: directory },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, `${out}\n${err}`).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    return
  }
  const { paths } = await import('../env')
  paths.db = ':memory:'
  await (await import('../bootstrap')).bootstrap()
  const { app } = await import('../app')
  const { db, newId } = await import('../db/client')
  const { chats, messages, lorebookVectors } = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  const { getChatRow, loadPath } = await import('./chats')
  const json = async <T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> => {
    const response = await app.request(`/api${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json() as Promise<T>
  }
  const connection = await json<ApiPresetDTO>('/connections', {
    name: 'Test',
    baseUrl: 'http://embedding.test/v1',
    model: 'chat',
    apiKey: 'secret',
    headers: { 'X-Test': 'yes' },
  })
  const actor = await json<CharacterDTO>('/characters', { name: 'Alice', first_mes: 'old keyword' })
  const chat = await json<ChatDTO>('/chats', { characterId: actor.id, apiPresetId: connection.id })
  const book = await json<LorebookDTO>('/lorebooks', { name: 'Test', isGlobal: true })
  const create = (body: unknown) => json<LorebookEntryDTO>(`/lorebooks/${book.id}/entries`, body)
  const semantic = await create({
    content: 'semantic content',
    vectorized: true,
    sticky: 4,
    cooldown: 3,
    automationId: 'quick',
  })
  const scored = await create({
    keys: ['keyword', 'old'],
    content: 'scored',
    group: 'g',
    groupScoring: true,
    automationId: 'score',
  })
  const low = await create({ keys: ['keyword'], content: 'low', group: 'g', groupScoring: true, groupWeight: 99999 })
  const min = await create({ keys: ['old'], content: 'minimum', automationId: 'minimum' })
  let settings = await json<WorldInfoSettings>(
    '/lorebooks/settings',
    {
      vectorEnabled: true,
      embeddingConnectionId: connection.id,
      embeddingModel: 'embed-1',
      vectorThreshold: 0.25,
      vectorMaxEntries: 5,
      vectorQueryMessages: 2,
      scanDepth: 1,
      minActivations: 3,
      maxDepth: 5,
    },
    'PUT',
  )
  expect(settings).toMatchObject({ embeddingModel: 'embed-1', vectorThreshold: 0.25, maxDepth: 5 })
  const embeddingInputs: string[][] = []
  let fail = false
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(url).endsWith('/embeddings')) {
          expect(String(url)).toBe('http://embedding.test/v1/embeddings')
          expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret')
          expect(new Headers(init?.headers).get('X-Test')).toBe('yes')
          const body = JSON.parse(String(init?.body)) as { model: string; input: string[] }
          expect(body.model).toMatch(/^embed-/)
          embeddingInputs.push(body.input)
          if (fail) return new Response('failed', { status: 503 })
          return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [1, 0] })).reverse() })
        }
        if (String(url).endsWith('/chat/completions'))
          return new Response(
            'data: {"choices":[{"delta":{"content":"Reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } },
          )
        throw new Error(`Unexpected URL ${String(url)}`)
      },
      { preconnect: fetch.preconnect },
    ),
  )
  const preview = (text = 'recent') => json<PromptPreview>(`/chats/${chat.id}/prompt-preview`, { text })
  try {
    const first = await preview()
    expect(first.report.worldInfo.find((item) => item.entryId === semantic.id)).toMatchObject({
      activated: true,
      reasonCode: 'vector',
    })
    expect(first.report.worldInfo.find((item) => item.entryId === scored.id)?.activated).toBe(true)
    expect(first.report.worldInfo.find((item) => item.entryId === low.id)?.activated).toBe(false)
    expect(first.report.worldInfo.find((item) => item.entryId === min.id)?.activated).toBe(true)
    expect(embeddingInputs[0]).toEqual(['semantic content', 'old keyword\nrecent'])
    await preview()
    expect(embeddingInputs[1]).toEqual(['old keyword\nrecent'])
    expect(db.select().from(lorebookVectors).all()).toHaveLength(1)
    await json(`/lorebooks/entries/${semantic.id}`, { content: 'changed' }, 'PATCH')
    await preview()
    expect(embeddingInputs.at(-1)?.[0]).toBe('changed')
    settings = await json<WorldInfoSettings>('/lorebooks/settings', { ...settings, embeddingModel: 'embed-2' }, 'PUT')
    await preview()
    expect(embeddingInputs.at(-1)?.[0]).toBe('changed')
    fail = true
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const failed = await preview()
    expect(failed.report.worldInfo.find((item) => item.entryId === semantic.id)?.activated).toBe(false)
    expect(failed.report.worldInfo.find((item) => item.entryId === min.id)?.activated).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    fail = false

    const generated = await app.request(`/api/chats/${chat.id}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'send', text: 'recent' }),
    })
    const events = await generated.text()
    expect(generated.status, events).toBe(200)
    const leaf = getChatRow(chat.id).activeLeafId!
    const reply = loadPath(leaf).at(-1)!
    expect(reply.status, events).toBe('done')
    expect(reply.meta.lore?.activated).toContain(semantic.id)
    expect(reply.meta.lore?.automationIds).toContain('quick')

    // 后续扫描关闭向量；粘滞仍生效，并且重新生成不会继承被替换回复的激活。
    settings = await json<WorldInfoSettings>(
      '/lorebooks/settings',
      { ...settings, vectorEnabled: false, minActivations: 0 },
      'PUT',
    )
    expect((await preview()).report.worldInfo.find((item) => item.entryId === semantic.id)?.reasonCode).toBe('sticky')
    const regenerated = await app.request(`/api/chats/${chat.id}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'regenerate', targetId: leaf }),
    })
    const regeneratedEvents = await regenerated.text()
    expect(regenerated.status, regeneratedEvents).toBe(200)
    expect(loadPath(getChatRow(chat.id).activeLeafId).at(-1)?.meta.lore?.activated).not.toContain(semantic.id)
    db.update(chats).set({ activeLeafId: leaf }).where(eq(chats.id, chat.id)).run()
    expect((await preview()).report.worldInfo.find((item) => item.entryId === semantic.id)?.reasonCode).toBe('sticky')

    const append = (parentId: string, activated: string[] = []) => {
      const id = newId()
      db.insert(messages)
        .values({
          id,
          chatId: chat.id,
          parentId,
          role: 'assistant',
          content: 'neutral',
          meta: { lore: { activated, automationIds: [] } },
          createdAt: Date.now(),
        })
        .run()
      db.update(chats).set({ activeLeafId: id }).where(eq(chats.id, chat.id)).run()
      return id
    }
    let parent = append(leaf, [semantic.id])
    parent = append(parent)
    expect((await preview()).report.worldInfo.find((item) => item.entryId === semantic.id)?.skippedCode).toBe(
      'cooldown',
    )
    for (let i = 0; i < 3; i++) parent = append(parent)
    expect((await preview()).report.worldInfo.find((item) => item.entryId === semantic.id)?.skippedCode).toBe(
      'no_match',
    )
    await json(`/lorebooks/entries/${semantic.id}`, { constant: true }, 'PATCH')
    await json('/lorebooks/settings', { ...settings, budgetCap: 1 }, 'PUT')
    const budget = await preview()
    expect(budget.report.worldInfo.find((item) => item.entryId === semantic.id)).toMatchObject({
      reasonCode: 'constant',
      activated: false,
      skippedCode: 'budget',
    })
    await json(`/lorebooks/entries/${semantic.id}`, undefined, 'DELETE')
    expect(db.select().from(lorebookVectors).all()).toHaveLength(0)

    // 单独验证最大扫描深度、延迟、递归和组内优先，避免向量结果掩盖这些规则。
    await json(
      '/lorebooks/settings',
      { ...settings, scanDepth: 1, minActivations: 2, maxDepth: 1, budgetCap: 0 },
      'PUT',
    )
    const shallow = await preview()
    expect(shallow.report.worldInfo.find((item) => item.entryId === min.id)?.activated).toBe(false)
    await json(
      '/lorebooks/settings',
      { ...settings, scanDepth: 1, minActivations: 2, maxDepth: 0, budgetCap: 0 },
      'PUT',
    )
    expect((await preview()).report.worldInfo.find((item) => item.entryId === min.id)?.activated).toBe(true)
    const delayed = await create({ constant: true, delay: 999, content: 'delay' })
    expect((await preview()).report.worldInfo.some((item) => item.entryId === delayed.id)).toBe(false)
    await json(`/lorebooks/entries/${delayed.id}`, { delay: 1 }, 'PATCH')
    expect((await preview()).report.worldInfo.find((item) => item.entryId === delayed.id)?.activated).toBe(true)
    const source = await create({ constant: true, content: 'recursive_keyword' })
    const recursive = await create({
      keys: ['recursive_keyword'],
      secondaryKeys: ['recent'],
      content: 'recursive',
      delayUntilRecursion: true,
    })
    const recursiveReport = (await preview()).report.worldInfo
    expect(recursiveReport.find((item) => item.entryId === source.id)?.activated).toBe(true)
    expect(recursiveReport.find((item) => item.entryId === recursive.id)).toMatchObject({
      activated: true,
      reasonCode: 'recursive',
      reasonParams: { key: 'recursive_keyword' },
    })
    const priority = await create({
      constant: true,
      group: 'priority',
      groupPrioritize: true,
      order: 1,
      content: 'priority',
    })
    const higher = await create({ constant: true, group: 'priority', order: 999, content: 'higher' })
    const priorityReport = (await preview()).report.worldInfo
    expect(priorityReport.find((item) => item.entryId === priority.id)?.activated).toBe(true)
    expect(priorityReport.find((item) => item.entryId === higher.id)?.skippedCode).toBe('group')
  } finally {
    fetchMock.mockRestore()
  }
}, 30_000)
