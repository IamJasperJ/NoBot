import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BookmarkDTO,
  CharacterDTO,
  ChatDTO,
  MessageDTO,
  MessageMeta,
  MessageRole,
  PromptPreview,
} from '@ai-parter/shared'
import { eq } from 'drizzle-orm'
import { mockLlm } from './helpers/mockLlm'

test('消息操作：排除、思考过程、书签和分支式移动', async () => {
  // 数据库和生成任务都是模块单例，在子进程里验证，避免污染其他集成测试。
  if (!process.env.MSG_OPS_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', 'apps/server/test/messages-ops.test.ts'], {
      env: { ...process.env, MSG_OPS_TEST_CHILD: '1', MOCK_LLM_FETCH: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'ai-parter-msg-'))
  process.env.DATA_DIR = directory
  const { paths } = await import('../src/env')
  paths.db = ':memory:'
  const { bootstrap } = await import('../src/bootstrap')
  await bootstrap()
  const { db, sqlite, newId, setSetting } = await import('../src/db/client')
  const { chats, messages, bookmarks, personas } = await import('../src/db/schema')
  const { app } = await import('../src/app')
  const { loadPath, loadMessage } = await import('../src/services/chats')
  const { assemble, loadGenerationContext } = await import('../src/services/context')
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
  async function error(path: string, status: number, code: string, body?: unknown, method = 'POST') {
    const response = await request(path, method, body)
    expect(response.status).toBe(status)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code)
  }
  try {
    const character = await json<CharacterDTO>('/characters', 'POST', { name: '角色甲', firstMes: '' })
    const createChat = () => json<ChatDTO>('/chats', 'POST', { characterId: character.id })
    function add(chatId: string, parentId: string | null, role: MessageRole, content: string, meta: MessageMeta = {}) {
      const id = newId()
      db.insert(messages)
        .values({
          id,
          chatId,
          parentId,
          role,
          content,
          meta,
          speakerId: role === 'assistant' ? character.id : null,
          createdAt: Date.now(),
        })
        .run()
      db.update(chats).set({ activeLeafId: id }).where(eq(chats.id, chatId)).run()
      return id
    }
    const chat = await createChat()
    const a = add(chat.id, null, 'user', '唯一排除内容')
    const b = add(chat.id, a, 'assistant', '回答', { reasoning: '旧思考' })
    const exclude = (ids: string[], excluded: boolean) =>
      json<MessageDTO[]>(`/chats/${chat.id}/exclude`, 'POST', { messageIds: ids, excluded })
    const preview = () => json<PromptPreview>(`/chats/${chat.id}/prompt-preview`, 'POST', {})
    expect((await exclude([a], true))[0]?.meta.excluded).toBe(true)
    let prompt = await preview()
    expect(prompt.messages.some((m) => m.content.includes('唯一排除内容'))).toBe(false)
    expect(prompt.report.excludedCount).toBe(1)
    expect(Object.hasOwn((await exclude([a], false))[0]!.meta, 'excluded')).toBe(false)
    prompt = await preview()
    expect(prompt.messages.some((m) => m.content.includes('唯一排除内容'))).toBe(true)
    expect(prompt.report.excludedCount).toBe(0)
    await exclude([b], true)
    const ctx = loadGenerationContext(chat.id, { requireConnection: false })
    expect(assemble(ctx, { type: 'normal', speakerId: character.id, leafId: a }).report.excludedCount).toBe(0)
    await exclude([b], false)
    const other = await createChat()
    const foreign = add(other.id, null, 'user', '其他会话')
    await error(`/chats/${chat.id}/exclude`, 404, 'NOT_FOUND', { messageIds: [a, foreign], excluded: true })
    expect(loadMessage(a).meta.excluded).toBeUndefined()

    const edit = (input: { content: string; reasoning?: string }) => json<MessageDTO>(`/messages/${b}`, 'PATCH', input)
    expect((await edit({ content: '回答', reasoning: ' 新思考 ' })).meta.reasoning).toBe(' 新思考 ')
    expect((await edit({ content: '修改回答' })).meta.reasoning).toBe(' 新思考 ')
    expect(Object.hasOwn((await edit({ content: '回答', reasoning: '  ' })).meta, 'reasoning')).toBe(false)

    const caller = add(chat.id, b, 'assistant', '', {
      toolCalls: [
        { id: 'call1', name: 'one', arguments: '{}' },
        { id: 'call2', name: 'two', arguments: '{}' },
      ],
    })
    const t1 = add(chat.id, caller, 'tool', '结果一', { toolCallId: 'call1', toolName: 'one' })
    const t2 = add(chat.id, t1, 'tool', '结果二', { toolCallId: 'call2', toolName: 'two' })
    const after = add(chat.id, t2, 'assistant', '工具后续')
    const sibling = add(chat.id, caller, 'tool', '兄弟结果', { toolCallId: 'call1' })
    const paired = await exclude([t2], true)
    expect(paired.map((m) => m.id)).toEqual([caller, t1, t2])
    expect(paired.every((m) => m.meta.excluded === true)).toBe(true)
    expect(loadMessage(sibling).meta.excluded).toBeUndefined()
    // 切回原结果链后从 assistant 恢复，默认子链规则使用最新备选。
    db.delete(messages).where(eq(messages.id, sibling)).run()
    db.update(chats).set({ activeLeafId: after }).where(eq(chats.id, chat.id)).run()
    const restored = await exclude([caller], false)
    expect(restored).toHaveLength(3)
    expect(restored.every((m) => !Object.hasOwn(m.meta, 'excluded'))).toBe(true)
    expect(loadMessage(after).meta.excluded).toBeUndefined()

    setSetting('defaultPersonaId', null)
    db.update(chats).set({ personaId: null }).where(eq(chats.id, chat.id)).run()
    const longText = `  ${'😀'.repeat(21)}\n${'文'.repeat(45)}  `
    const marked = add(chat.id, after, 'user', longText, { name: '旧人设' })
    const mark = await json<BookmarkDTO>(`/chats/${chat.id}/bookmarks`, 'POST', { messageId: marked })
    expect(mark.name).toBe('😀'.repeat(20))
    expect(mark.preview.text).toBe(`${'😀'.repeat(21)} ${'文'.repeat(38)}…`)
    expect(mark.preview.name).toBe('旧人设')
    const personaId = newId()
    db.insert(personas).values({ id: personaId, name: '当前人设', createdAt: Date.now(), updatedAt: Date.now() }).run()
    db.update(chats).set({ personaId }).where(eq(chats.id, chat.id)).run()
    const list = () => json<BookmarkDTO[]>(`/chats/${chat.id}/bookmarks`)
    expect((await list())[0]?.preview.name).toBe('当前人设')
    expect(mark.onPath).toBe(true)
    const descendant = add(chat.id, marked, 'assistant', '子树旧叶子')
    const latest = add(chat.id, marked, 'assistant', '子树最新叶子')
    const alternate = add(chat.id, after, 'user', '备选')
    await json(`/chats/${chat.id}/swipe`, 'POST', { messageId: alternate, direction: -1 })
    await json(`/chats/${chat.id}/swipe`, 'POST', { messageId: marked, direction: 1 })
    expect((await list())[0]?.onPath).toBe(false)
    expect((await json<{ leafId: string }>(`/chats/${chat.id}/activate`, 'POST', { messageId: marked })).leafId).toBe(
      latest,
    )
    expect((await list())[0]?.onPath).toBe(true)
    expect(db.select().from(chats).where(eq(chats.id, chat.id)).get()?.activeLeafId).toBe(latest)
    expect(loadMessage(descendant).content).toBe('子树旧叶子')
    // exact（读档）：激活叶子就是这条消息本身，不往下找最新的叶子
    expect(
      (await json<{ leafId: string }>(`/chats/${chat.id}/activate`, 'POST', { messageId: marked, exact: true })).leafId,
    ).toBe(marked)
    expect(db.select().from(chats).where(eq(chats.id, chat.id)).get()?.activeLeafId).toBe(marked)
    await json(`/chats/${chat.id}/activate`, 'POST', { messageId: marked })
    await error(`/chats/${chat.id}/activate`, 404, 'NOT_FOUND', { messageId: foreign })
    await error(`/chats/${chat.id}/bookmarks`, 404, 'NOT_FOUND', { messageId: foreign })
    expect((await json<BookmarkDTO>(`/bookmarks/${mark.id}`, 'PATCH', { name: '改名' })).name).toBe('改名')
    await json(`/bookmarks/${mark.id}`, 'DELETE')
    await error(`/bookmarks/${mark.id}`, 404, 'NOT_FOUND', { name: '再改' }, 'PATCH')
    await error(`/bookmarks/${mark.id}`, 404, 'NOT_FOUND', undefined, 'DELETE')
    await json(`/chats/${chat.id}/bookmarks`, 'POST', { messageId: marked })
    const branched = await json<ChatDTO>(`/chats/${chat.id}/branch`, 'POST', { messageId: marked })
    expect(await json<BookmarkDTO[]>(`/chats/${branched.id}/bookmarks`)).toEqual([])
    await json(`/messages/${marked}`, 'DELETE')
    expect(await list()).toEqual([])
    const emptyChat = await createChat()
    const image = add(emptyChat.id, null, 'assistant', '', { imageGen: { status: 'done', mode: 'last' } })
    const emptyMark = await json<BookmarkDTO>(`/chats/${emptyChat.id}/bookmarks`, 'POST', {
      messageId: image,
      name: '  ',
    })
    expect(emptyMark.name).toBe('书签 1')
    expect(emptyMark.preview).toEqual({ role: 'assistant', name: '角色甲', text: '（图片）' })
    await json(`/chats/${emptyChat.id}`, 'DELETE')
    expect(db.select().from(bookmarks).where(eq(bookmarks.id, emptyMark.id)).all()).toEqual([])

    const moving = await createChat()
    const ma = add(moving.id, null, 'user', 'A')
    const mb = add(moving.id, ma, 'assistant', 'B', { reasoning: '完整保留', excluded: true })
    const mc = add(moving.id, mb, 'user', 'C')
    const md = add(moving.id, mc, 'assistant', 'D')
    const move = (messageId: string, direction: 'up' | 'down') =>
      json<{ leafId: string }>(`/chats/${moving.id}/move`, 'POST', { messageId, direction })
    const original = loadPath(md)
    const movingMark = await json<BookmarkDTO>(`/chats/${moving.id}/bookmarks`, 'POST', { messageId: mc })
    const moved = await move(mc, 'up')
    const movedPath = loadPath(moved.leafId)
    expect(movedPath.map((m) => m.content)).toEqual(['A', 'C', 'B', 'D'])
    expect(movedPath.at(-1)?.id).not.toBe(md)
    expect(movedPath[0]?.id).toBe(ma)
    expect(movedPath[2]?.meta).toEqual(original[1]!.meta)
    expect(movedPath.slice(1).map((m) => m.createdAt)).toEqual([
      original[2]!.createdAt,
      original[1]!.createdAt,
      original[3]!.createdAt,
    ])
    expect(loadPath(md).map((m) => m.id)).toEqual([ma, mb, mc, md])
    expect(loadMessage(mb).swipeCount).toBe(2)
    expect((await json<BookmarkDTO[]>(`/chats/${moving.id}/bookmarks`))[0]).toMatchObject({
      id: movingMark.id,
      messageId: mc,
      onPath: false,
    })
    await error(`/chats/${moving.id}/move`, 400, 'NOT_ON_PATH', { messageId: mc, direction: 'up' })
    await json(`/chats/${moving.id}/activate`, 'POST', { messageId: mb })
    const down = await move(mb, 'down')
    expect(loadPath(down.leafId).map((m) => m.content)).toEqual(['A', 'C', 'B', 'D'])
    await error(`/chats/${moving.id}/move`, 400, 'CANNOT_MOVE', { messageId: ma, direction: 'up' })
    await error(`/chats/${moving.id}/move`, 400, 'CANNOT_MOVE', { messageId: down.leafId, direction: 'down' })
    await json(`/chats/${chat.id}/activate`, 'POST', { messageId: caller })
    for (const [id, direction] of [
      [caller, 'up'],
      [t1, 'up'],
      [after, 'up'],
      [b, 'down'],
    ] as const) {
      await error(`/chats/${chat.id}/move`, 400, 'CANNOT_MOVE', { messageId: id, direction })
    }
    const streaming = add(moving.id, down.leafId, 'assistant', '生成中')
    db.update(messages).set({ status: 'streaming' }).where(eq(messages.id, streaming)).run()
    await error(`/chats/${moving.id}/move`, 409, 'GENERATING', { messageId: streaming, direction: 'up' })

    const model = mockLlm()
    const generation = await import('../src/services/generation')
    try {
      model.setScript(() => ({ text: '慢速模拟生成', delayMs: 20 }))
      await json('/connections', 'POST', { name: '模拟连接', baseUrl: model.url, model: 'mock' })
      db.update(messages).set({ status: 'done' }).where(eq(messages.id, streaming)).run()
      const job = generation.startGeneration(moving.id, { mode: 'trigger' })
      const complete = new Promise<void>((resolve) =>
        generation.subscribe(job, (event) => {
          if (event.type === 'complete') resolve()
        }),
      )
      try {
        expect(generation.isGenerating(moving.id)).toBe(true)
        await error(`/chats/${moving.id}/activate`, 409, 'GENERATING', { messageId: ma })
        await error(`/chats/${moving.id}/move`, 409, 'GENERATING', { messageId: down.leafId, direction: 'up' })
      } finally {
        generation.abortGeneration(moving.id)
        await complete
      }
      // 既验证生成中允许排除，也验证完成写库不会覆盖标记；续写恢复同理。
      for (const excluded of [true, false]) {
        const target = db.select().from(chats).where(eq(chats.id, moving.id)).get()!.activeLeafId!
        const current = generation.startGeneration(moving.id, { mode: 'continue', targetId: target })
        const done = new Promise<void>((resolve) =>
          generation.subscribe(current, (event) => {
            if (event.type === 'complete') resolve()
          }),
        )
        try {
          const changed = await json<MessageDTO[]>(`/chats/${moving.id}/exclude`, 'POST', {
            messageIds: [target],
            excluded,
          })
          expect(changed[0]?.meta.excluded).toBe(excluded ? true : undefined)
        } finally {
          await done
        }
        expect(loadMessage(target).meta.excluded).toBe(excluded ? true : undefined)
      }
    } finally {
      await model.stop()
    }
  } finally {
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
