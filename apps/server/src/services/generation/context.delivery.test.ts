import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CharacterDTO, ChatDTO, MessageMeta, MessageRole } from '@nobot/shared'

// 注册表和数据库是单例，用子进程隔离，且所有路由直接在内存调用，无需监听端口。
test('助手历史规范化演绎标签，保留其他角色、图片回退和数据库原文', async () => {
  if (!process.env.DELIVERY_TEST_CHILD) {
    const child = Bun.spawn(
      [process.execPath, 'test', 'apps/server/src/services/generation/context.delivery.test.ts'],
      {
        env: { ...process.env, DELIVERY_TEST_CHILD: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, `${out}\n${err}`).toBe(0)
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'nobot-delivery-'))
  process.env.DATA_DIR = directory
  let sqlite: typeof import('../../db/client').sqlite | undefined
  try {
    await (await import('../../bootstrap')).bootstrap()
    const database = await import('../../db/client')
    sqlite = database.sqlite
    const { chats, messages } = await import('../../db/schema')
    const { app } = await import('../../app')
    const { eq } = await import('drizzle-orm')
    const { assemble, loadGenerationContext } = await import('./context')
    async function json<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
      const response = await app.request(`/api${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }),
      })
      const value: unknown = await response.json()
      expect(response.status, JSON.stringify(value)).toBe(200)
      return value as T
    }
    const actor = await json<CharacterDTO>('/characters', 'POST', { name: '旅伴' })
    const chat = await json<ChatDTO>('/chats', 'POST', { characterId: actor.id })
    const { toHistory } = await import('./context')
    const { resolvePlayPreset } = await import('./stage')
    const { playPresets } = await import('../../db/schema')
    const play = resolvePlayPreset(chat.id)
    const raw = '<screaming>甲</screaming><gasp>乙</gasp><laughs/>丙'
    const normalized = '<shout>甲</shout><gasp/>乙<laugh/>丙'
    let parentId = chat.activeLeafId
    const records: { id: string; role: MessageRole; content: string; meta: MessageMeta }[] = [
      { id: 'delivery-user', role: 'user', content: raw, meta: {} },
      { id: 'delivery-assistant', role: 'assistant', content: raw, meta: {} },
      { id: 'delivery-tool', role: 'tool', content: raw, meta: { toolCallId: 'test' } },
      {
        id: 'delivery-caption',
        role: 'assistant',
        content: '',
        meta: { imageGen: { status: 'done', mode: 'last', caption: raw } },
      },
      {
        id: 'delivery-image',
        role: 'assistant',
        content: '',
        meta: { imageGen: { status: 'done', mode: 'last', prompt: raw } },
      },
    ]
    for (const record of records) {
      database.db
        .insert(messages)
        .values({ ...record, chatId: chat.id, parentId, createdAt: 1 })
        .run()
      parentId = record.id
    }
    database.db.update(chats).set({ activeLeafId: parentId }).where(eq(chats.id, chat.id)).run()
    for (const enabled of [false, true]) {
      database.db
        .update(playPresets)
        .set({
          data: { ...play.data, directives: { ...play.data.directives, enabled, keepInHistory: true, keepRecent: 0 } },
        })
        .where(eq(playPresets.id, play.id))
        .run()
      const ctx = loadGenerationContext(chat.id, { requireConnection: false })
      const history = toHistory(ctx, parentId)
      expect(history.find((m) => m.id === 'delivery-assistant')?.content).toBe(normalized)
      expect(history.find((m) => m.id === 'delivery-user')?.content).toBe(raw)
      expect(history.find((m) => m.id === 'delivery-tool')?.content).toBe(raw)
      expect(history.find((m) => m.id === 'delivery-caption')?.content).toBe(raw)
      expect(history.find((m) => m.id === 'delivery-image')?.content).toBe(`(Sent an image: ${raw})`)
      const built = assemble(ctx, { type: 'normal', speakerId: actor.id, leafId: 'delivery-assistant' })
      expect(built.messages.some((m) => m.role === 'assistant' && m.content === normalized)).toBe(true)
      expect(toHistory(ctx, parentId, true).find((m) => m.id === 'delivery-assistant')?.content).toBe('甲乙丙')
      if (enabled) {
        database.db
          .update(playPresets)
          .set({
            data: { ...play.data, directives: { ...play.data.directives, enabled, keepInHistory: false } },
          })
          .where(eq(playPresets.id, play.id))
          .run()
        expect(toHistory(ctx, parentId).find((m) => m.id === 'delivery-assistant')?.content).toBe('甲乙丙')
      }
    }
    expect(database.db.select().from(messages).where(eq(messages.id, 'delivery-assistant')).get()?.content).toBe(raw)
  } finally {
    sqlite?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
