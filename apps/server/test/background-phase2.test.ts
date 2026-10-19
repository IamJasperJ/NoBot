import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BackgroundDTO,
  BackgroundFolderDTO,
  CharacterDTO,
  ChatDTO,
  ChatPage,
  GenerateEvent,
  GroupDTO,
  LorebookEntryDTO,
  MessageDTO,
} from '@nobot/shared'
import { mockLlm } from './helpers/mockLlm'
import { readSSE } from './helpers/sse'

// 数据库与扩展注册表都是单例，子进程隔离保证全量测试不会串库。
test('背景二期：默认引用、世界书与定期切换、文件夹多对多和批量清理', async () => {
  if (!process.env.BG_PHASE2_CHILD) {
    const directory = await mkdtemp(join(tmpdir(), 'nobot-bg-phase2-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        env: { ...process.env, DATA_DIR: directory, BG_PHASE2_CHILD: '1', MOCK_LLM_FETCH: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, out + err).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    return
  }
  const { paths } = await import('../src/env')
  paths.db = ':memory:'
  await (await import('../src/bootstrap')).bootstrap()
  const { sqlite } = await import('../src/db/client')
  const { app } = await import('../src/app')
  const { saveBackground } = await import('../src/services/backgrounds')
  const { backgroundReplyCount } = await import('../src/services/auto-background')
  const { loadPath } = await import('../src/services/chats')
  const model = mockLlm()
  const request = (path: string, method = 'GET', input?: unknown) =>
    app.request(`/api${path}`, {
      method,
      ...(input === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
    })
  const json = async <T>(path: string, method = 'GET', input?: unknown): Promise<T> => {
    const response = await request(path, method, input)
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json() as Promise<T>
  }
  const page = (id: string) => json<ChatPage>(`/chats/${id}`)
  const generate = async (
    id: string,
    input: unknown = { mode: 'send', text: 'enter forest' },
  ): Promise<GenerateEvent[]> => readSSE(await request(`/chats/${id}/generate`, 'POST', input))
  try {
    const png = new Uint8Array(await Bun.file('fixtures/images/test.png').arrayBuffer())
    const forest = await saveBackground(png, { name: 'Forest', source: 'upload' })
    const castle = await saveBackground(png, { name: 'Castle', source: 'upload' })
    const actor = await json<CharacterDTO>('/characters', 'POST', {
      name: 'Alice',
      first_mes: 'Welcome',
      defaultBackgroundId: forest.id,
    })
    expect(actor.defaultBackgroundId).toBe(forest.id)
    expect(
      (await json<CharacterDTO>(`/characters/${actor.id}`, 'PATCH', { description: 'test' })).defaultBackgroundId,
    ).toBe(forest.id)
    expect((await request(`/characters/${actor.id}`, 'PATCH', { defaultBackgroundId: 'missing' })).status).toBe(404)
    const group = await json<GroupDTO>('/groups', 'POST', {
      name: 'Party',
      members: [{ characterId: actor.id }],
      defaultBackgroundId: castle.id,
    })
    expect(group.defaultBackgroundId).toBe(castle.id)
    expect((await json<GroupDTO>(`/groups/${group.id}`, 'PATCH', { name: 'Party 2' })).defaultBackgroundId).toBe(
      castle.id,
    )
    const chat = await json<ChatDTO>('/chats', 'POST', { characterId: actor.id })
    const groupChat = await json<ChatDTO>('/chats', 'POST', { groupId: group.id })
    expect((await page(groupChat.id)).group?.defaultBackgroundId).toBe(castle.id)
    expect(chat.autoBackground).toEqual({ lore: false, everyN: 0 })
    expect((await request(`/chats/${chat.id}`, 'PATCH', { autoBackground: { lore: true, everyN: -1 } })).status).toBe(
      400,
    )
    const generated = await saveBackground(png, { name: 'Generated', source: 'generated', chatId: chat.id })

    const folder = await json<BackgroundFolderDTO>('/backgrounds/folders', 'POST', {
      name: 'Scenes',
      coverBackgroundId: forest.id,
      sort: 2,
    })
    const folder2 = await json<BackgroundFolderDTO>('/backgrounds/folders', 'POST', { name: 'Favorites', sort: 1 })
    expect((await json<BackgroundFolderDTO[]>('/backgrounds/folders')).map((f) => f.id)).toEqual([
      folder2.id,
      folder.id,
    ])
    expect(
      (await json<BackgroundFolderDTO>(`/backgrounds/folders/${folder.id}`, 'PATCH', { name: 'Maps' }))
        .coverBackgroundId,
    ).toBe(forest.id)
    expect((await request('/backgrounds/folders', 'POST', { name: '  ' })).status).toBe(400)
    expect((await request('/backgrounds/folders', 'POST', { name: 'x', coverBackgroundId: 'missing' })).status).toBe(
      404,
    )
    await json('/backgrounds/folders/add', 'POST', {
      folderId: folder.id,
      backgroundIds: [forest.id, castle.id, forest.id, generated.id],
    })
    await json('/backgrounds/folders/add', 'POST', { folderId: folder2.id, backgroundIds: [forest.id] })
    expect((await json<BackgroundDTO[]>(`/backgrounds?folderId=${folder.id}`)).map((b) => b.id).sort()).toEqual(
      [forest.id, castle.id, generated.id].sort(),
    )
    expect((await json<BackgroundDTO[]>('/backgrounds')).find((b) => b.id === forest.id)?.folderIds.sort()).toEqual(
      [folder.id, folder2.id].sort(),
    )
    expect(
      (
        await request('/backgrounds/folders/add', 'POST', {
          folderId: folder2.id,
          backgroundIds: [castle.id, 'missing'],
        })
      ).status,
    ).toBe(404)
    expect((await json<BackgroundDTO[]>(`/backgrounds?folderId=${folder2.id}`)).map((b) => b.id)).toEqual([forest.id])
    await json('/backgrounds/folders/remove', 'POST', { folderId: folder.id, backgroundIds: [forest.id] })
    expect((await json<BackgroundDTO[]>(`/backgrounds?folderId=${folder.id}`)).map((b) => b.id)).not.toContain(
      forest.id,
    )
    await json(`/backgrounds/folders/${folder2.id}`, 'DELETE')
    expect((await json<BackgroundDTO[]>('/backgrounds')).find((b) => b.id === forest.id)?.folderIds).toEqual([])
    expect((await request('/backgrounds?folderId=missing')).status).toBe(404)

    await json('/connections', 'POST', { name: 'Mock', baseUrl: model.url, model: 'mock-one' })
    model.setScript((body) => ({ text: body.stream ? 'We reached the forest.' : 'Castle' }))
    const book = await json<{ id: string }>('/lorebooks', 'POST', { name: 'Map' })
    const entry = await json<LorebookEntryDTO>(`/lorebooks/${book.id}/entries`, 'POST', {
      keys: ['forest'],
      content: 'Forest scenery',
      backgroundId: forest.id,
      order: 200,
    })
    await json(`/lorebooks/${book.id}/entries`, 'POST', {
      keys: ['forest'],
      content: 'Castle scenery',
      backgroundId: castle.id,
      order: 100,
    })
    await json(`/lorebooks/${book.id}/entries`, 'POST', {
      keys: ['never-match'],
      content: 'Unused',
      backgroundId: castle.id,
      order: 999,
    })
    await json(`/chats/${chat.id}`, 'PATCH', { lorebookIds: [book.id], autoBackground: { lore: true, everyN: 0 } })
    const first = await generate(chat.id)
    expect(first.some((event) => event.type === 'error')).toBe(false)
    expect((await page(chat.id)).chat.backgroundId).toBe(forest.id)
    expect(model.requests).toHaveLength(1)
    expect(backgroundReplyCount(loadPath((await page(chat.id)).chat.activeLeafId))).toBe(1)
    await json(`/chats/${chat.id}`, 'PATCH', { autoBackground: { lore: false, everyN: 2 } })
    await generate(chat.id)
    expect(model.requests).toHaveLength(3)
    expect(model.requests.filter((body) => !body.stream)).toHaveLength(1)
    expect((await page(chat.id)).chat.backgroundId).toBe(castle.id)
    const leaf = (await page(chat.id)).chat.activeLeafId!
    await generate(chat.id, { mode: 'continue', targetId: leaf })
    expect(model.requests.filter((body) => !body.stream)).toHaveLength(1)
    await generate(chat.id)
    expect(model.requests.filter((body) => !body.stream)).toHaveLength(1)
    await json(`/chats/${chat.id}`, 'PATCH', { autoBackground: { lore: true, everyN: 2 } })
    await generate(chat.id)
    expect(model.requests.filter((body) => !body.stream)).toHaveLength(2)
    expect((await page(chat.id)).chat.backgroundId).toBe(forest.id)
    // 模型选择失败不影响已生成回复，也不清掉已有背景。
    model.setScript((body) => (body.stream ? { text: 'Hello' } : { status: 500, error: 'failure' }))
    await json(`/chats/${chat.id}`, 'PATCH', { autoBackground: { lore: false, everyN: 1 } })
    const failedAuto = await generate(chat.id)
    expect(failedAuto.some((event) => event.type === 'error')).toBe(false)
    expect((await page(chat.id)).chat.backgroundId).toBe(forest.id)
    const path = loadPath((await page(chat.id)).chat.activeLeafId)
    const reply = path.at(-1)!
    const variants: MessageDTO[] = [
      { ...reply, role: 'user' },
      { ...reply, status: 'error' },
      { ...reply, status: 'aborted' },
      { ...reply, meta: {} },
      { ...reply, role: 'tool' },
      { ...reply, meta: { ...reply.meta, toolCalls: [{ id: 'tool', name: 'test', arguments: '{}' }] } },
      reply,
    ]
    expect(backgroundReplyCount(variants)).toBe(1)

    await json('/backgrounds/settings', 'PUT', { globalId: forest.id })
    await json(`/backgrounds/folders/${folder.id}`, 'PATCH', { coverBackgroundId: forest.id })
    expect((await request('/backgrounds/batch-delete', 'POST', { ids: [forest.id, 'missing'] })).status).toBe(404)
    expect((await json<BackgroundDTO[]>('/backgrounds')).some((b) => b.id === forest.id)).toBe(true)
    await json('/backgrounds/batch-delete', 'POST', { ids: [forest.id, generated.id, forest.id] })
    expect((await page(chat.id)).chat.backgroundId).toBeNull()
    expect((await json<CharacterDTO>(`/characters/${actor.id}`)).defaultBackgroundId).toBeNull()
    expect(await json('/backgrounds/settings')).toEqual({ globalId: null })
    expect((await json<BackgroundFolderDTO[]>('/backgrounds/folders'))[0]?.coverBackgroundId).toBeNull()
    expect(
      (await json<{ entries: LorebookEntryDTO[] }>(`/lorebooks/${book.id}`)).entries.find((e) => e.id === entry.id)
        ?.backgroundId,
    ).toBeNull()
    expect(await Bun.file(join(paths.backgrounds, `${generated.id}.webp`)).exists()).toBe(false)
    expect(await Bun.file(join(paths.backgrounds, `${forest.id}.thumb.webp`)).exists()).toBe(false)
    await json(`/backgrounds/${castle.id}`, 'DELETE')
    expect((await json<GroupDTO>(`/groups/${group.id}`)).defaultBackgroundId).toBeNull()
    expect(await json(`/backgrounds?folderId=${folder.id}`)).toEqual([])
    await json(`/backgrounds/folders/${folder.id}`, 'DELETE')
    expect(await json('/backgrounds/folders')).toEqual([])
    expect(sqlite.query('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    await model.stop()
    sqlite.close()
  }
}, 20000)
