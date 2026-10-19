import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CharacterDTO,
  ChatDTO,
  ChatPage,
  GenerateEvent,
  GroupDTO,
  LorebookDTO,
  MessageDTO,
  PlayPresetDTO,
  PromptPresetDTO,
  PromptPreview,
  TemporaryActorDTO,
} from '@nobot/shared'
import { eq } from 'drizzle-orm'
import { mockLlm } from './helpers/mockLlm'
import { readSSE } from './helpers/sse'

test('VN1：玩法预设、舞台、状态、历史与生成集成', async () => {
  if (!process.env.VN1_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', 'apps/server/test/stage.test.ts'], {
      env: { ...process.env, VN1_TEST_CHILD: '1', MOCK_LLM_FETCH: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'nobot-vn1-'))
  process.env.DATA_DIR = directory
  const { paths } = await import('../src/env')
  paths.db = ':memory:'
  const { bootstrap } = await import('../src/bootstrap')
  await bootstrap()
  const { db, sqlite, newId, setSetting } = await import('../src/db/client')
  const { backgrounds, characters, playPresets, personas, characterLorebooks } = await import('../src/db/schema')
  const { app } = await import('../src/app')
  const stage = await import('../src/services/stage')
  const chatService = await import('../src/services/chats')
  const { toHistory, loadGenerationContext } = await import('../src/services/context')
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
  const list = () => json<PlayPresetDTO[]>('/play-presets')
  const page = (id: string) => json<ChatPage>(`/chats/${id}`)
  const preview = (id: string) => json<PromptPreview>(`/chats/${id}/prompt-preview`, 'POST', {})
  const patch = (preset: PlayPresetDTO) =>
    json<PlayPresetDTO>(`/play-presets/${preset.id}`, 'PATCH', { data: preset.data })
  const upload = (text: string) => {
    const form = new FormData()
    form.set('file', new File([text], '玩法.json'))
    return app.request('/api/play-presets/import', { method: 'POST', body: form })
  }
  async function generate(id: string, body: unknown = { mode: 'send', text: '你好' }) {
    const events = await readSSE(await request(`/chats/${id}/generate`, 'POST', body))
    const done = events.filter((event): event is Extract<GenerateEvent, { type: 'done' }> => event.type === 'done')
    expect(done.length, JSON.stringify(events)).toBeGreaterThan(0)
    return done.at(-1)!.message
  }
  try {
    const seeded = await list()
    expect(seeded.map((preset) => preset.name)).toEqual(['普通聊天', '陪伴', 'Galgame', 'RPG', 'D&D 5e'])
    expect(seeded.every((preset) => preset.builtin)).toBe(true)
    const plain = seeded[0]!
    const gal = seeded[2]!
    expect(plain.isDefault).toBe(true)
    expect(JSON.parse(seeded[4]!.data.state.schema)['player.hp'].init).toBe(10)
    await bootstrap()
    expect((await list()).length).toBe(5)
    // 重置内置预设：名字和设置回到内置默认；补回只补缺少的那几个
    await json(`/play-presets/${gal.id}`, 'PATCH', { name: '改过', data: { directives: { enabled: false } } })
    const reset = await json<PlayPresetDTO>(`/play-presets/${gal.id}/reset`, 'POST')
    expect(reset.name).toBe('Galgame')
    expect(reset.data).toEqual(gal.data)
    await json(`/play-presets/${seeded[1]!.id}`, 'DELETE')
    expect((await json<{ restored: number }>('/play-presets/restore-builtins', 'POST')).restored).toBe(1)
    expect((await list()).map((preset) => preset.name)).toContain('陪伴')
    const actor = await json<CharacterDTO>('/characters', 'POST', { name: '艾莉丝', description: '测试角色' })
    const chat = await json<ChatDTO>('/chats', 'POST', { characterId: actor.id })
    // 开场白里的指令：建会话时还没绑预设，绑上 Galgame 后打开会话会补解析
    const greeter = await json<CharacterDTO>('/characters', 'POST', {
      name: '米拉',
      first_mes: '<scene place="花店" />\n米拉[joy]：「欢迎光临！」',
    })
    const greetChat = await json<ChatDTO>('/chats', 'POST', { characterId: greeter.id })
    await json(`/chats/${greetChat.id}`, 'PATCH', { playPresetId: gal.id })
    const greeted = await page(greetChat.id)
    expect(greeted.stage?.scene.place).toBe('花店')
    expect(greeted.stage?.cast.map((m) => [m.name, m.expression])).toEqual([['米拉', 'joy']])
    expect(greeted.messages[0]?.meta.stage?.beats.length).toBeGreaterThan(0)
    const created = await json<PlayPresetDTO>('/play-presets', 'POST', {
      name: '自定义',
      data: { directives: { enabled: true } },
    })
    expect(created.builtin).toBe(false)
    const renamed = await json<PlayPresetDTO>(`/play-presets/${created.id}`, 'PATCH', { name: '改名' })
    expect(renamed.data).toEqual(created.data)
    const copy = await json<PlayPresetDTO>(`/play-presets/${created.id}/duplicate`, 'POST')
    expect(copy.name).toBe('改名 副本')
    await json(`/play-presets/${copy.id}/default`, 'POST')
    expect(stage.resolvePlayPreset(chat.id).id).toBe(copy.id)
    const exported = await json<Record<string, unknown>>(`/play-presets/${created.id}/export`)
    expect(exported.type).toBe('nobot-play-preset')
    const imported = (await (await upload(JSON.stringify(exported))).json()) as PlayPresetDTO
    expect(imported.data).toEqual(created.data)
    for (const text of [
      '非 JSON',
      '{"type":"wrong"}',
      '{"type":"nobot-play-preset","name":"坏预设","data":{"basic":{"layout":"bad"}}}',
    ]) {
      const response = await upload(text)
      expect(response.status).toBe(400)
      expect((await response.json()).error.code).toBe('BAD_PLAY_PRESET')
    }
    const minimalImport = (await (
      await upload('{"type":"nobot-play-preset","version":1,"name":"补默认","data":{}}')
    ).json()) as PlayPresetDTO
    expect(minimalImport.data.directives.enabled).toBe(false)
    db.update(characters)
      .set({ extensions: { nobot_vn: { preset: 'Galgame' } } })
      .where(eq(characters.id, actor.id))
      .run()
    expect(stage.resolvePlayPreset(chat.id).id).toBe(gal.id)
    await json(`/chats/${chat.id}`, 'PATCH', { playPresetId: plain.id })
    expect((await page(chat.id)).chat.playPresetId).toBe(plain.id)
    expect(stage.resolvePlayPreset(chat.id).id).toBe(plain.id)
    expect((await request(`/chats/${chat.id}`, 'PATCH', { playPresetId: 'missing' })).status).toBe(404)
    await json(`/chats/${chat.id}`, 'PATCH', { playPresetId: copy.id })
    await json(`/play-presets/${copy.id}`, 'DELETE')
    expect((await page(chat.id)).chat.playPresetId).toBeNull()
    expect(stage.resolvePlayPreset(chat.id).id).toBe(gal.id)
    expect((await list()).filter((preset) => preset.isDefault).map((preset) => preset.id)).toEqual([plain.id])

    const second = await json<CharacterDTO>('/characters', 'POST', { name: '旅伴' })
    const group = await json<GroupDTO>('/groups', 'POST', {
      name: '群组',
      members: [{ characterId: actor.id }, { characterId: second.id }],
    })
    // 群成员顺序由接口的 members 字段指定。
    await json(`/groups/${group.id}`, 'PATCH', { members: [{ characterId: actor.id }, { characterId: second.id }] })
    const groupChat = await json<ChatDTO>('/chats', 'POST', { groupId: group.id })
    db.update(characters)
      .set({ extensions: { nobot_vn: { preset: 'RPG', schema: '{"共同":{"init":1},"甲":{"init":2}}' } } })
      .where(eq(characters.id, actor.id))
      .run()
    db.update(characters)
      .set({ extensions: { nobot_vn: { preset: 'Galgame', schema: '{"共同":{"init":9},"乙":{"init":3}}' } } })
      .where(eq(characters.id, second.id))
      .run()
    expect(stage.resolvePlayPreset(groupChat.id).id).toBe(seeded[3]!.id)
    expect(stage.resolveStateSchema(groupChat.id, gal.data).共同?.init).toBe(1)
    expect(stage.resolveStateSchema(groupChat.id, gal.data).乙?.init).toBe(3)
    expect(
      stage.resolveStateSchema(groupChat.id, { ...gal.data, state: { ...gal.data.state, schemaSource: 'preset' } })
        .共同,
    ).toBeUndefined()
    expect(
      stage.resolveStateSchema(groupChat.id, { ...gal.data, state: { ...gal.data.state, schemaSource: 'card' } })
        .affection,
    ).toBeUndefined()
    db.update(characters).set({ extensions: {} }).where(eq(characters.id, actor.id)).run()

    await json('/connections', 'POST', { name: '模拟模型', baseUrl: model.url, model: 'mock-one' })
    await json(`/chats/${chat.id}`, 'PATCH', { playPresetId: plain.id })
    model.setScript(() => ({ text: '艾莉丝[joy]：你好' }))
    const normal = await generate(chat.id)
    expect(normal.meta.stage).toBeUndefined()
    expect(normal.meta.varsPatch).toBeUndefined()
    expect((await preview(chat.id)).report.segments.some((segment) => segment.source === 'stage')).toBe(false)
    expect((await page(chat.id)).stage).toBeNull()
    expect((await page(chat.id)).vars).toEqual({})
    await json(`/chats/${chat.id}`, 'PATCH', { playPresetId: gal.id })
    const bgId = newId()
    db.insert(backgrounds)
      .values({ id: bgId, name: '黄昏的酒馆', width: 1, height: 1, source: 'upload', createdAt: Date.now() })
      .run()
    model.setScript(() => ({ text: '<scene bg=" 黄昏的酒馆 " />\n艾莉丝[joy]：欢迎\n<state>affection += 2</state>' }))
    const first = await generate(chat.id)
    // 切到 Galgame 后，之前「普通聊天」下生成的回复在生成前被补解析
    expect(chatService.loadMessage(normal.id).meta.stage?.ops).toEqual([
      { op: 'expr', who: '艾莉丝', expression: 'joy' },
    ])
    expect(first.meta.stage?.ops.length).toBe(2)
    expect(first.meta.varsPatch).toEqual({ affection: 32 })
    let current = await page(chat.id)
    expect(current.vars).toMatchObject({ affection: 32, day: 'Day 1' })
    // VN 视图从这条回复开头演：取它之前的舞台，不含它自己的场景和上台
    const stageBefore = () =>
      json<{ stage: ChatPage['stage']; temporarySprites: Record<string, string> }>(
        `/chats/${chat.id}/stage?before=${first.id}`,
      )
    const before = await stageBefore()
    expect(before.stage?.scene.bg).toBeUndefined()
    expect(before.temporarySprites).toEqual({})
    const temporaryActor: TemporaryActorDTO = {
      key: '商队车夫',
      name: '商队车夫',
      image: { id: 'driver', url: '/driver.png', width: 1, height: 1 },
      prompt: '',
      status: 'done',
      updatedAt: 1,
    }
    setSetting(`vn-actors:${chat.id}`, {
      driver: temporaryActor,
      removed: { ...temporaryActor, key: 'removed', status: 'removed' },
      pending: { ...temporaryActor, key: 'pending', image: null, status: 'pending' },
      retrying: { ...temporaryActor, key: 'retrying', status: 'error' },
    })
    // 不在历史舞台上的演员也要返回；重试失败但仍有旧图时遵循舞台的相同规则。
    expect((await stageBefore()).temporarySprites).toEqual({ 商队车夫: '/driver.png', retrying: '/driver.png' })
    setSetting(`vn-actors:${chat.id}`, {})
    expect(current.stage?.scene.backgroundId).toBe(bgId)
    expect((await request(`/chats/${chat.id}/stage?before=nope`)).status).toBe(404)
    expect(current.stage?.scene.backgroundId).toBe(bgId)
    expect(current.stage?.cast[0]?.name).toBe('艾莉丝')
    model.setScript(() => ({ text: '<scene bg="森林" />\n<state>affection += 5</state>' }))
    const regenerated = await generate(chat.id, { mode: 'regenerate', targetId: first.id })
    expect((await page(chat.id)).vars.affection).toBe(35)
    expect((await page(chat.id)).stage?.scene.backgroundId).toBeNull()
    await json(`/chats/${chat.id}/swipe`, 'POST', { messageId: regenerated.id, direction: -1 })
    expect((await page(chat.id)).vars.affection).toBe(32)
    expect((await page(chat.id)).stage?.scene.backgroundId).toBe(bgId)
    const edited = await json<MessageDTO>(`/messages/${first.id}`, 'PATCH', {
      content: '<scene bg="酒馆" />\n<state>affection += 7</state>',
    })
    expect(edited.meta.varsPatch?.affection).toBe(37)
    expect((await page(chat.id)).stage?.scene.backgroundId).toBe(bgId)
    const longer = newId()
    db.insert(backgrounds)
      .values({ id: longer, name: '华丽黄昏的酒馆', width: 1, height: 1, source: 'upload', createdAt: Date.now() })
      .run()
    expect((await page(chat.id)).stage?.scene.backgroundId).toBe(longer)
    const asciiBg = newId()
    db.insert(backgrounds)
      .values({ id: asciiBg, name: ' Tavern ', width: 1, height: 1, source: 'upload', createdAt: Date.now() })
      .run()
    const sceneFor = (bg: string) =>
      stage.computeStage(chat.id, [{ meta: { stage: { v: 1, beats: [], ops: [{ op: 'scene', bg }] } } }])
    expect(sceneFor('TAVERN')?.scene.backgroundId).toBe(asciiBg)
    expect(sceneFor('Inside Tavern tonight')?.scene.backgroundId).toBe(asciiBg)
    expect(sceneFor('Tavren')?.scene.backgroundId).toBeNull()

    await json(`/messages/${first.id}`, 'PATCH', {
      content: '<scene bg="不存在" />\n<UpdateVariable>_.set(\'affection\', 30, 45);</UpdateVariable>',
    })
    expect((await page(chat.id)).vars.affection).toBe(45)
    expect((await page(chat.id)).stage?.scene.backgroundId).toBeNull()

    const book = await json<LorebookDTO>('/lorebooks', 'POST', { name: '初值', isGlobal: true })
    await json(`/lorebooks/${book.id}/entries`, 'POST', {
      comment: '[InitVar] 初始值',
      enabled: false,
      content: '{"金币":[12,"奖励时增加"],"affection":31}',
    })
    expect(stage.initialVars(chat.id)).toMatchObject({
      vars: { 金币: 12, affection: 31 },
      rules: { 金币: '奖励时增加' },
    })
    const cardBook = await json<LorebookDTO>('/lorebooks', 'POST', { name: '角色初值' })
    await json(`/lorebooks/${cardBook.id}/entries`, 'POST', {
      comment: '[InitVar]',
      enabled: false,
      content: '{"角色值":1}',
    })
    db.insert(characterLorebooks).values({ characterId: actor.id, lorebookId: cardBook.id, position: 0 }).run()
    const personaBook = await json<LorebookDTO>('/lorebooks', 'POST', { name: '人设初值' })
    await json(`/lorebooks/${personaBook.id}/entries`, 'POST', {
      comment: '[InitVar]',
      enabled: false,
      content: '{"人设值":2}',
    })
    db.update(personas).set({ lorebookId: personaBook.id }).run()
    const chatBook = await json<LorebookDTO>('/lorebooks', 'POST', { name: '会话初值' })
    await json(`/lorebooks/${chatBook.id}/entries`, 'POST', {
      comment: '[InitVar]',
      enabled: false,
      content: '{"会话值":3}',
    })
    await json(`/chats/${chat.id}`, 'PATCH', { lorebookIds: [chatBook.id] })
    expect(stage.initialVars(chat.id).vars).toMatchObject({ 角色值: 1, 人设值: 2, 会话值: 3 })
    for (const position of ['after_char', 'author_note', 'depth'] as const) {
      gal.data.directives.position = position
      gal.data.directives.depth = 1
      await patch(gal)
      const result = await preview(chat.id)
      const segment = result.report.segments.find((segment) => segment.source === 'stage')
      expect(segment?.label).toContain('舞台指令')
      expect(segment?.content).toContain('艾莉丝')
      expect(segment?.content).toContain('45')
      if (position !== 'after_char') expect(segment?.depth).toBe(position === 'author_note' ? 4 : 1)
    }
    gal.data.directives.keepInHistory = false
    await patch(gal)
    let history = toHistory(
      loadGenerationContext(chat.id, { requireConnection: false }),
      chatService.getChatRow(chat.id).activeLeafId,
    )
    expect(
      history
        .filter((m) => m.role === 'assistant')
        .every((m) => !m.content.includes('<state>') && !m.content.includes('[joy]') && !m.content.includes('_.set')),
    ).toBe(true)
    gal.data.directives.keepInHistory = true
    gal.data.directives.keepRecent = 1
    await patch(gal)
    history = toHistory(loadGenerationContext(chat.id, { requireConnection: false }), first.id)
    expect(history.filter((m) => m.role === 'assistant').at(-1)?.content).toContain('_.set')
    expect(history.find((m) => m.id === normal.id)?.content).not.toContain('<state>')
    model.setScript(() => ({ text: '\n<state>金币 += 1</state>' }))
    await generate(chat.id, { mode: 'continue', targetId: first.id })
    expect((await page(chat.id)).vars).toMatchObject({ affection: 45, 金币: 13 })

    const prompt = (await json<PromptPresetDTO[]>('/presets'))[0]!
    prompt.data.samplers.functionCalling = true
    await json(`/presets/${prompt.id}`, 'PATCH', { data: prompt.data })
    let round = 0
    model.setScript(() =>
      round++ === 0
        ? { toolCalls: [{ id: 'set', name: 'set_chat_state', arguments: '{"key":"金币","value":20}' }] }
        : round === 2
          ? { toolCalls: [{ id: 'get', name: 'get_chat_state', arguments: '{}' }] }
          : { text: '<state>金币 += 2</state>' },
    )
    await generate(chat.id)
    current = await page(chat.id)
    expect(current.vars.金币).toBe(22)
    expect(
      current.messages.some(
        (m) => m.role === 'tool' && m.meta.toolName === 'set_chat_state' && m.content.includes('13'),
      ),
    ).toBe(true)
    expect(
      current.messages.some(
        (m) => m.role === 'tool' && m.meta.toolName === 'get_chat_state' && m.content.includes('20'),
      ),
    ).toBe(true)
    gal.data.directives.enabled = false
    await patch(gal)
    const last = current.messages.at(-1)!
    await json(`/messages/${last.id}`, 'PATCH', { content: '<state>金币 = 99</state>' })
    expect(chatService.loadMessage(last.id).meta.varsPatch).toBeUndefined()
    expect(chatService.loadMessage(last.id).meta.stage).toBeUndefined()
    // 默认键失效时使用列表第一项，并且删除最后一个的保护不依赖内置标志。
    setSetting('defaultPlayPresetId', 'missing')
    expect((await list()).find((preset) => preset.isDefault)?.id).toBe(plain.id)
    for (const preset of (await list()).slice(1)) await json(`/play-presets/${preset.id}`, 'DELETE')
    const response = await request(`/play-presets/${plain.id}`, 'DELETE')
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe('LAST_PLAY_PRESET')
    await bootstrap()
    expect((await list()).map((preset) => preset.name)).toEqual(['普通聊天'])
    expect(db.select().from(playPresets).all().length).toBe(1)
    expect(
      chatService.computeVars(
        [
          { role: 'user', meta: { varsPatch: { a: 1 } } },
          { role: 'system', meta: { varsPatch: { b: null } } },
        ],
        { b: 2 },
      ),
    ).toEqual({ a: 1 })
  } finally {
    await model.stop()
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
