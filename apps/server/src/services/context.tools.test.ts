import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CharacterDTO, ChatDTO, PromptPresetDTO, PromptPreview } from '@nobot/shared'

// 注册表和数据库是单例，用子进程隔离，且所有路由直接在内存调用，无需监听端口。
test('工具启用集合在预览和组装中按会话过滤历史', async () => {
  if (!process.env.TOOLS2_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', 'apps/server/src/services/context.tools.test.ts'], {
      env: { ...process.env, TOOLS2_TEST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, `${out}\n${err}`).toBe(0)
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'nobot-tools2-'))
  process.env.DATA_DIR = directory
  let sqlite: typeof import('../db/client').sqlite | undefined
  try {
    await (await import('../bootstrap')).bootstrap()
    const database = await import('../db/client')
    sqlite = database.sqlite
    const { chats, messages } = await import('../db/schema')
    const { app } = await import('../app')
    const { eq } = await import('drizzle-orm')
    const { assemble, loadGenerationContext } = await import('./context')
    const { enabledToolNames, toOpenAITools } = await import('../tools')
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
    const preset = (await json<PromptPresetDTO[]>('/presets'))[0]!
    const calls = [
      { id: 'time', name: 'get_current_time', arguments: '{}' },
      { id: 'dice', name: 'roll_dice', arguments: '{}' },
      { id: 'image', name: 'generate_image', arguments: '{}' },
    ]
    database.db
      .insert(messages)
      .values({
        id: 'calls',
        chatId: chat.id,
        parentId: chat.activeLeafId,
        role: 'assistant',
        content: '',
        meta: { toolCalls: calls },
        createdAt: 1,
      })
      .run()
    let parentId = 'calls'
    for (const call of calls) {
      database.db
        .insert(messages)
        .values({
          id: call.id,
          chatId: chat.id,
          parentId,
          role: 'tool',
          content: `结果-${call.name}`,
          meta: { toolCallId: call.id, toolName: call.name },
          createdAt: 2,
        })
        .run()
      parentId = call.id
    }
    database.db.update(chats).set({ activeLeafId: parentId }).where(eq(chats.id, chat.id)).run()
    await json('/extensions/image-gen', 'PATCH', { enabled: true, settings: { toolEnabled: true } })
    await json(`/presets/${preset.id}`, 'PATCH', {
      ...preset,
      data: {
        ...preset.data,
        samplers: { ...preset.data.samplers, functionCalling: true, disabledTools: ['get_current_time'] },
      },
    })
    const preview = () => json<PromptPreview>(`/chats/${chat.id}/prompt-preview`, 'POST', {})
    let built = await preview()
    expect(built.report.omittedToolCalls).toBe(1)
    expect(built.messages.find((m) => m.tool_calls)?.tool_calls?.map((c) => c.function.name)).toEqual([
      'roll_dice',
      'generate_image',
    ])
    expect(JSON.stringify(built.messages)).not.toContain('get_current_time')
    for (const patch of [{ enabled: false }, { enabled: true, settings: { toolEnabled: false } }]) {
      await json('/extensions/image-gen', 'PATCH', patch)
      built = await preview()
      expect(built.report.omittedToolCalls).toBe(2)
      expect(built.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['dice'])
      expect(JSON.stringify(built.messages)).not.toContain('generate_image')
      const ctx = loadGenerationContext(chat.id, { requireConnection: false })
      expect(assemble(ctx, { type: 'normal', speakerId: actor.id, leafId: parentId }).messages).toEqual(built.messages)
      const enabled = enabledToolNames(chat.id, ctx.preset.samplers)
      expect(enabled).not.toContain('generate_image')
      expect(toOpenAITools(ctx.preset.samplers.disabledTools, chat.id).map((t) => t.function.name)).toEqual(enabled)
    }
    await json(`/presets/${preset.id}`, 'PATCH', {
      ...preset,
      data: { ...preset.data, samplers: { ...preset.data.samplers, functionCalling: false } },
    })
    built = await preview()
    expect(built.report.omittedToolCalls).toBe(3)
    expect(built.messages.some((m) => m.tool_calls || m.role === 'tool')).toBe(false)
    expect(JSON.stringify(built.messages)).not.toContain('结果-')
    const saved = await json<{ messages: { id: string }[] }>(`/chats/${chat.id}`)
    expect(saved.messages.some((m) => m.id === 'image')).toBe(true)
  } finally {
    sqlite?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
