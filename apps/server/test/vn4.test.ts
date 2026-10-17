import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toDisplayText } from '@ai-parter/core/stage'
import type {
  BookmarkDTO,
  CharacterDTO,
  ChatDTO,
  ChatPage,
  LorebookDTO,
  MessageMeta,
  PlayPresetDTO,
  PromptPreview,
} from '@ai-parter/shared'
import { eq } from 'drizzle-orm'
import type { ServerEvent } from '../src/extensions/types'
import { mockLlm } from './helpers/mockLlm'
import { readSSE } from './helpers/sse'

// 数据库和扩展使用单例，子进程保证与其他集成场景互不影响。
test('VN4：手动变量、阶段世界书与固定存档快照', async () => {
  if (!process.env.VN4_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', 'apps/server/test/vn4.test.ts'], {
      env: { ...process.env, VN4_TEST_CHILD: '1', MOCK_LLM_FETCH: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'ai-parter-vn4-'))
  process.env.DATA_DIR = directory
  const { paths } = await import('../src/env')
  paths.db = ':memory:'
  await (await import('../src/bootstrap')).bootstrap()
  const { db, sqlite, newId } = await import('../src/db/client')
  const { chats, messages, characters, backgrounds, sprites } = await import('../src/db/schema')
  const service = await import('../src/services/chats')
  const { applyStageParse } = await import('../src/services/stage')
  const { app } = await import('../src/app')
  const { registerBuiltinExtension } = await import('../src/extensions/registry')
  const events: ServerEvent[] = []
  registerBuiltinExtension({
    id: 'vn4-events',
    name: '测试事件',
    description: '',
    version: '1',
    enabledByDefault: true,
    hooks: {
      onEvent: (event) => {
        events.push(event)
      },
    },
  })
  const model = mockLlm()
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
  const page = (id: string) => json<ChatPage>(`/chats/${id}`)
  const preview = (id: string) => json<PromptPreview>(`/chats/${id}/prompt-preview`, 'POST', {})
  try {
    const presets = await json<PlayPresetDTO[]>('/play-presets')
    const gal = presets.find((preset) => preset.name === 'Galgame')!
    expect(gal.data.interaction.stageLore).toBe(true)
    expect(JSON.parse(gal.data.state.schema).affection.pin).toBe(true)
    expect(presets.find((preset) => preset.name === '陪伴')!.data.interaction.hud).toBe(false)
    expect(presets.find((preset) => preset.name === 'RPG')!.data.interaction.choiceLayout).toBe('column')
    const schema = JSON.parse(gal.data.state.schema)
    schema.items = { type: 'list', pin: true, init: ['剑', '药'] }
    schema.energy = { type: 'meter', pin: true, init: 3, max: 'energyMax' }
    schema.energyMax = { type: 'number', init: 8 }
    gal.data.state.schema = JSON.stringify(schema)
    // 宏与虚拟扫描都应独立于舞台说明注入开关。
    gal.data.directives.inject = false
    await json(`/play-presets/${gal.id}`, 'PATCH', { data: gal.data })
    const actor = await json<CharacterDTO>('/characters', 'POST', {
      name: 'Alice',
      description: 'Current relationship: {{stage::affection}}; missing: {{stage::missing}}',
    })
    db.update(characters).set({ avatarFile: 'alice.png' }).where(eq(characters.id, actor.id)).run()
    const chat = await json<ChatDTO>('/chats', 'POST', { characterId: actor.id })
    await json(`/chats/${chat.id}`, 'PATCH', { playPresetId: gal.id })
    expect((await request(`/chats/${chat.id}/vars`, 'POST', { set: {} })).status).toBe(400)
    expect((await request(`/chats/${chat.id}/saves`, 'POST', {})).status).toBe(400)
    const add = (parentId: string | null, content: string, extra: MessageMeta = {}) => {
      const id = newId()
      const meta = applyStageParse(chat.id, { role: 'assistant', status: 'done', parentId, meta: extra }, content)
      db.insert(messages)
        .values({
          id,
          chatId: chat.id,
          parentId,
          role: 'assistant',
          content,
          status: 'done',
          meta,
          createdAt: Date.now(),
        })
        .run()
      db.update(chats).set({ activeLeafId: id }).where(eq(chats.id, chat.id)).run()
      return id
    }
    const root = add(null, '<state>affection = 30</state>')
    const book = await json<LorebookDTO>('/lorebooks', 'POST', { name: '恋人事件', isGlobal: true })
    await json(`/lorebooks/${book.id}/entries`, 'POST', {
      comment: '恋人',
      keys: ['affection_stage: Lovers'],
      content: 'Relationship event: {{stage::affection}}',
      scanDepth: 0,
    })
    const activated = (result: PromptPreview) =>
      result.report.worldInfo.some((entry) => entry.comment === '恋人' && entry.activated)
    expect(activated(await preview(chat.id))).toBe(false)
    expect(
      (await preview(chat.id)).messages.some((message) => message.content.includes('Current relationship: Strangers')),
    ).toBe(true)
    const leaf = add(root, '<state>affection = 35\ndelete day</state>', { varsManual: { affection: 36 } })
    expect((await page(chat.id)).vars.affection).toBe(36)
    expect((await page(chat.id)).stateSchema.affection?.pin).toBe(true)
    await json(`/chats/${chat.id}/vars`, 'POST', { set: { affection: 94, removed: 1 } })
    const updated = await json<{ vars: Record<string, unknown> }>(`/chats/${chat.id}/vars`, 'POST', {
      set: { affection: 95, removed: null },
    })
    expect(updated.vars.affection).toBe(95)
    expect(updated.vars).not.toHaveProperty('removed')
    expect(updated.vars).not.toHaveProperty('day')
    expect(
      events.some(
        (event) =>
          event.type === 'message:updated' &&
          event.message.id === leaf &&
          event.message.meta.varsManual?.affection === 95,
      ),
    ).toBe(true)
    expect(service.loadMessage(leaf).meta.varsManual).toEqual({ affection: 95, removed: null })
    // 玩法预设关掉「允许修改数值」后，手动修改被拒绝，原值不变
    gal.data.interaction.varEdit = false
    await json(`/play-presets/${gal.id}`, 'PATCH', { data: gal.data })
    const denied = await request(`/chats/${chat.id}/vars`, 'POST', { set: { affection: 1 } })
    expect(denied.status).toBe(403)
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('VAR_EDIT_DISABLED')
    expect((await page(chat.id)).vars.affection).toBe(95)
    gal.data.interaction.varEdit = true
    await json(`/play-presets/${gal.id}`, 'PATCH', { data: gal.data })
    const before = await json<{ vars: Record<string, unknown> }>(`/chats/${chat.id}/stage?before=${leaf}`)
    expect(before.vars.affection).toBe(30)
    expect(before.vars.day).toBe('Day 1')
    const lovers = await preview(chat.id)
    expect(activated(lovers)).toBe(true)
    expect(lovers.messages.some((message) => message.content.includes('Relationship event: Lovers'))).toBe(true)
    expect(lovers.messages.some((message) => message.content.includes('affection_stage:'))).toBe(false)
    gal.data.interaction.stageLore = false
    await json(`/play-presets/${gal.id}`, 'PATCH', { data: gal.data })
    expect(activated(await preview(chat.id))).toBe(false)
    gal.data.interaction.stageLore = true
    gal.data.directives.enabled = false
    await json(`/play-presets/${gal.id}`, 'PATCH', { data: gal.data })
    expect(activated(await preview(chat.id))).toBe(false)
    expect((await page(chat.id)).stateSchema).toEqual({})
    gal.data.directives.enabled = true
    await json(`/play-presets/${gal.id}`, 'PATCH', { data: gal.data })
    const sibling = add(root, '另一条分支')
    expect((await page(chat.id)).vars.affection).toBe(30)
    await json(`/chats/${chat.id}/activate`, 'POST', { messageId: leaf })
    expect((await page(chat.id)).vars.affection).toBe(95)
    const bg = newId()
    const fallbackBg = newId()
    for (const [id, name] of [
      [bg, 'Garden'],
      [fallbackBg, 'Fallback'],
    ]) {
      db.insert(backgrounds)
        .values({ id: id!, name: name!, mime: 'image/webp', width: 1, height: 1, source: 'upload', createdAt: 1 })
        .run()
    }
    await json(`/chats/${chat.id}`, 'PATCH', { backgroundId: fallbackBg })
    const spriteId = newId()
    db.insert(sprites)
      .values({
        id: spriteId,
        characterId: actor.id,
        expression: 'neutral',
        ext: 'png',
        width: 1,
        height: 1,
        createdAt: 1,
      })
      .run()
    const content =
      '<scene bg="Garden" place="花园" time="Evening" />\n<show who="Bob" />\n<show who="Carol" />\n<show who="Dave" />\nAlice[joy]：「' +
      '😀'.repeat(70) +
      '」'
    const savedMessage = add(leaf, content)
    const mark = await json<BookmarkDTO>(`/chats/${chat.id}/bookmarks`, 'POST', { messageId: savedMessage })
    expect(mark.kind).toBe('bookmark')
    expect(mark.snapshot).toBeNull()
    const save = await json<BookmarkDTO>(`/chats/${chat.id}/saves`, 'POST', {})
    expect(save.kind).toBe('save')
    expect(save.name).toBe('存档 1 · 花园')
    expect(save.messageId).toBe(savedMessage)
    expect(save.snapshot).toEqual({
      backgroundUrl: `/api/assets/backgrounds/${bg}.webp`,
      actors: [
        {
          name: 'Alice',
          characterId: actor.id,
          spriteUrl: `/api/assets/sprites/${actor.id}/${spriteId}.png`,
          avatarUrl: expect.stringContaining('alice.webp?v='),
        },
        { name: 'Bob', characterId: null, spriteUrl: null, avatarUrl: null },
        { name: 'Carol', characterId: null, spriteUrl: null, avatarUrl: null },
      ],
      place: '花园',
      time: 'Evening',
      text: Array.from(toDisplayText(content, { knownNames: [], speaker: 'plain' }))
        .slice(0, 60)
        .join(''),
      vars: [
        ['好感', '95/100'],
        ['日期', ''],
        ['时间', 'Morning'],
        ['items', '剑、药'],
        ['energy', '3/8'],
      ],
    })
    await json(`/chats/${chat.id}/vars`, 'POST', { set: { affection: 1 } })
    await json(`/messages/${savedMessage}`, 'PATCH', { content: '<scene bg="Unknown" place="新地点" />\n改变正文' })
    const list = await json<BookmarkDTO[]>(`/chats/${chat.id}/bookmarks`)
    expect(list.find((item) => item.id === save.id)?.snapshot).toEqual(save.snapshot)
    const secondSave = await json<BookmarkDTO>(`/chats/${chat.id}/saves`, 'POST', {})
    expect(secondSave.name).toBe('存档 2 · 新地点')
    expect(secondSave.snapshot?.backgroundUrl).toBe(`/api/assets/backgrounds/${fallbackBg}.webp`)
    await json(`/chats/${chat.id}/activate`, 'POST', { messageId: sibling })
    await json(`/chats/${chat.id}/activate`, 'POST', { messageId: save.messageId })
    expect(service.loadPath((await page(chat.id)).chat.activeLeafId).map((message) => message.id)).toEqual([
      root,
      leaf,
      savedMessage,
    ])
    const explicit = await json<BookmarkDTO>(`/chats/${chat.id}/saves`, 'POST', { messageId: root, name: '起点' })
    expect(explicit.name).toBe('起点')
    expect(explicit.snapshot?.backgroundUrl).toBe(`/api/assets/backgrounds/${fallbackBg}.webp`)
    expect(explicit.snapshot?.actors).toEqual([])
    const foreignChat = await json<ChatDTO>('/chats', 'POST', { characterId: actor.id })
    expect((await request(`/chats/${foreignChat.id}/saves`, 'POST', { messageId: root })).status).toBe(404)
    expect((await request(`/chats/${foreignChat.id}/stage?before=${root}`)).status).toBe(404)
    expect((await request(`/chats/${chat.id}/saves`, 'POST', { messageId: 'missing' })).status).toBe(404)
    expect((await json<BookmarkDTO>(`/bookmarks/${save.id}`, 'PATCH', { name: '改名存档' })).snapshot).toEqual(
      save.snapshot,
    )
    await json(`/bookmarks/${save.id}`, 'DELETE')
    expect((await json<BookmarkDTO[]>(`/chats/${chat.id}/bookmarks`)).some((item) => item.id === save.id)).toBe(false)
    await json('/connections', 'POST', { name: '模拟模型', baseUrl: model.url, model: 'mock-one' })
    model.setScript(() => ({ text: 'Testing', delayMs: 10 }))
    const response = await request(`/chats/${chat.id}/generate`, 'POST', { mode: 'send', text: '继续' })
    const rejected = await request(`/chats/${chat.id}/vars`, 'POST', { set: { affection: 20 } })
    expect(rejected.status).toBe(409)
    expect((await rejected.json()).error.code).toBe('GENERATING')
    await readSSE(response)
    expect(
      service.computeVars([{ role: 'user', meta: { varsPatch: { a: 1, b: 2 }, varsManual: { a: null, b: 3 } } }]),
    ).toEqual({ b: 3 })
  } finally {
    model.stop()
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 20000)
