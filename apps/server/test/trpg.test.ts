import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ChatPage,
  type CheckResult,
  characterSheetSchema,
  type GenerateEvent,
  type PersonaDTO,
  type PlayPresetDTO,
} from '@nobot/shared'
import { eq } from 'drizzle-orm'
import { mockLlm } from './helpers/mockLlm'
import { readSSE } from './helpers/sse'

test('VN5：属性卡、检定、工具、提示词与战斗分支集成', async () => {
  if (!process.env.VN5_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', 'apps/server/test/trpg.test.ts'], {
      env: { ...process.env, VN5_TEST_CHILD: '1', MOCK_LLM_FETCH: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'nobot-vn5-'))
  process.env.DATA_DIR = directory
  const { paths } = await import('../src/env')
  paths.db = ':memory:'
  const { bootstrap } = await import('../src/bootstrap')
  await bootstrap()
  const { db, sqlite, newId } = await import('../src/db/client')
  const { messages, playPresets } = await import('../src/db/schema')
  const { app } = await import('../src/app')
  const chars = await import('../src/services/characters')
  const personas = await import('../src/services/personas')
  const chats = await import('../src/services/chats')
  const stage = await import('../src/services/stage')
  const trpg = await import('../src/services/trpg')
  const { availableTools, runTool } = await import('../src/tools')
  const { assemble, loadGenerationContext, toHistory } = await import('../src/services/context')
  const model = mockLlm()
  const request = (path: string, body?: unknown) =>
    app.request(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
  try {
    const sheet = characterSheetSchema.parse({ hpMax: 34, abilities: { dex: 16, wis: 18 }, skills: ['perception'] })
    const persona = personas.createPersona({ name: 'Hero', sheet })
    expect(persona.sheet).toEqual(sheet)
    expect(personas.updatePersona(persona.id, { description: '勇者' }).sheet).toEqual(sheet)
    expect(personas.updatePersona(persona.id, { sheet: null }).sheet).toBeNull()
    personas.updatePersona(persona.id, { sheet })
    const actor = chars.createCharacter({ name: 'Ellie Sunleaf', sheet, extensions: { nobot: { custom: true } } })
    expect(chars.getCharacter(actor.id).sheet).toEqual(sheet)
    expect(chars.updateCharacter(actor.id, { description: '队友' }).sheet).toEqual(sheet)
    const card = await chars.exportCharacter(actor.id, 'json')
    const data = JSON.parse(new TextDecoder().decode(card.bytes))
    expect(data.data.extensions.nobot).toEqual({ custom: true, sheet })
    const imported = await chars.importCharacter(card.bytes)
    expect(imported.sheet).toEqual(sheet)
    const pngCard = await chars.exportCharacter(actor.id, 'png')
    expect((await chars.importCharacter(pngCard.bytes)).sheet).toEqual(sheet)
    expect(chars.updateCharacter(imported.id, { sheet: null }).sheet).toBeNull()
    const presets = (await (await request('/play-presets')).json()) as PlayPresetDTO[]
    const dnd = presets.find((row) => row.name === 'D&D 5e')!
    const plain = presets.find((row) => !row.data.directives.enabled)!
    const chat = chats.createChat({ characterId: actor.id })
    chats.updateChat(chat.id, { personaId: persona.id, playPresetId: dnd.id })
    expect(stage.initialVars(chat.id).vars).toMatchObject({
      'player.hp': 34,
      'player.ac': 10,
      'player.wis': 18,
      'Ellie Sunleaf.dex': 16,
    })
    for (const who of ['player', 'PLAYER', 'Hero', 'me', '我'])
      expect(trpg.resolveWho(chat.id, who).prefix).toBe('player')
    for (const who of ['ellie', 'ELLIE SUNLEAF']) expect(trpg.resolveWho(chat.id, who).characterId).toBe(actor.id)
    expect(trpg.resolveWho(chat.id, 'Goblin').sheet).toBeNull()
    db.update(playPresets)
      .set({ data: { ...dnd.data, state: { ...dnd.data.state, initVar: false } } })
      .where(eq(playPresets.id, dnd.id))
      .run()
    expect(stage.initialVars(chat.id).vars['player.hp']).toBe(34)
    db.update(playPresets).set({ data: dnd.data }).where(eq(playPresets.id, dnd.id)).run()
    const base = stage.initialVars(chat.id).vars
    expect(
      chats.computeVars(
        [{ role: 'user', meta: { varsPatch: { 'player.hp': 8 }, varsManual: { 'player.hp': 6 } } }],
        base,
      )['player.hp'],
    ).toBe(6)
    const book = (await (await request('/lorebooks', { name: '初始变量' })).json()) as { id: string }
    await request(`/lorebooks/${book.id}/entries`, {
      comment: '[InitVar]',
      content: '{"player.hp":22}',
      constant: true,
    })
    personas.updatePersona(persona.id, { lorebookId: book.id })
    expect(stage.initialVars(chat.id).vars['player.hp']).toBe(22)
    const ctx = {
      chatId: chat.id,
      vars: { ...base, 'Goblin.dex': 18, 'Goblin.skills': ['stealth'], 'Goblin.proficiencyBonus': 2 },
      random: () => 0.99,
    }
    const dice = await runTool('roll_dice', '{"expression":"4d6kh3","reason":"damage"}', ctx)
    expect(dice.meta?.dice).toMatchObject({ total: 18, reason: 'damage' })
    expect(dice.content).toContain('4d6kh3')
    const check = await runTool('ability_check', '{"who":"me","skill":"Perception","dc":100}', ctx)
    expect(check.meta?.check).toMatchObject({ who: 'Hero', bonus: 6, outcome: 'crit_success' })
    expect(check.content).toContain('[Check] Hero — Perception')
    expect((await runTool('ability_check', '{"who":"Goblin","skill":"stealth"}', ctx)).meta?.check).toMatchObject({
      source: 'vars',
      bonus: 6,
    })
    expect(trpg.performCheck(chat.id, { who: 'ellie', skill: 'dex', dc: null }, {}, () => 0).bonus).toBe(3)
    db.update(playPresets)
      .set({ data: { ...dnd.data, trpg: { ...dnd.data.trpg, critRules: false } } })
      .where(eq(playPresets.id, dnd.id))
      .run()
    expect(trpg.performCheck(chat.id, { skill: 'str', dc: 100 }, {}, () => 0.99).outcome).toBe('fail')
    const before = db.select().from(messages).all().length
    const response = await request(`/chats/${chat.id}/check`, { skill: 'Perception', dc: 12 })
    expect(response.status).toBe(200)
    const result = (await response.json()) as CheckResult
    expect(result).toMatchObject({ who: 'Hero', skill: 'perception', bonus: 6 })
    expect(db.select().from(messages).all().length).toBe(before)
    expect((await request(`/chats/${chat.id}/check`, { skill: '', dc: -1 })).status).toBe(400)
    const prompt = assemble(loadGenerationContext(chat.id, { requireConnection: false }), {
      type: 'normal',
      speakerId: actor.id,
      leafId: null,
    })
      .messages.map((m) => m.content)
      .join('\n')
    expect(prompt).toContain('<combat start: A, B>')
    expect(prompt).toContain('player: D&D 5e')
    expect(prompt).toContain('Ellie Sunleaf: D&D 5e')
    await request('/connections', { name: '模拟模型', baseUrl: model.url, model: 'mock-one' })
    model.setScript(() => ({ text: '<combat start: player, Ellie, Goblin>' }))
    const events = await readSSE(
      await request(`/chats/${chat.id}/generate`, { mode: 'send', text: '侦察', check: result }),
    )
    const done = events
      .filter((event): event is Extract<GenerateEvent, { type: 'done' }> => event.type === 'done')
      .at(-1)!.message
    const path = chats.loadPath(done.id)
    expect(path.find((m) => m.role === 'user')).toMatchObject({ content: '侦察', meta: { check: result } })
    expect(
      toHistory(loadGenerationContext(chat.id, { requireConnection: false }), done.id).find((m) => m.role === 'user')
        ?.content,
    ).toContain('\n[Check] Hero')
    expect(
      model.requests.some((r) =>
        r.messages.some((m) => typeof m.content === 'string' && m.content.includes('[Check] Hero')),
      ),
    ).toBe(true)
    const resolvedPreset = loadGenerationContext(chat.id, { requireConnection: false }).preset
    const { promptPresets } = await import('../src/db/schema')
    const allPresets = db.select().from(promptPresets).all()
    const defaultPreset = allPresets[0]!
    db.update(promptPresets)
      .set({ data: { ...resolvedPreset, samplers: { ...resolvedPreset.samplers, functionCalling: true } } })
      .where(eq(promptPresets.id, defaultPreset.id))
      .run()
    model.setScript((body) =>
      body.messages.at(-1)?.role === 'tool'
        ? { text: 'Checks complete.' }
        : {
            toolCalls: [
              { id: 'dice-vn5', name: 'roll_dice', arguments: '{"expression":"d20","reason":"attack"}' },
              { id: 'check-vn5', name: 'ability_check', arguments: '{"who":"player","skill":"Perception","dc":12}' },
            ],
          },
    )
    await readSSE(await request(`/chats/${chat.id}/generate`, { mode: 'send', text: '掷骰' }))
    const toolMessages = chats.loadPath(chats.getChatRow(chat.id).activeLeafId).filter((m) => m.role === 'tool')
    expect(toolMessages.find((m) => m.meta.toolName === 'roll_dice')?.meta.dice?.reason).toBe('attack')
    expect(toolMessages.find((m) => m.meta.toolName === 'ability_check')?.meta.check?.skill).toBe('perception')
    const resolved = stage.applyStageParse(
      chat.id,
      { role: 'assistant', status: 'done', parentId: done.id, meta: {} },
      '<combat start: player, Ellie, Goblin>',
      () => 0,
    )
    expect(resolved.stage?.ops[0]).toMatchObject({
      order: [{ initiative: 4 }, { initiative: 4, characterId: actor.id }, { initiative: 1 }],
    })
    const beat = resolved.stage?.beats.find((b) => b.kind === 'stage')
    if (beat?.kind === 'stage') expect(beat.ops[0]).toEqual(resolved.stage?.ops[0])
    const startId = newId()
    db.insert(messages)
      .values({
        id: startId,
        chatId: chat.id,
        parentId: done.id,
        role: 'assistant',
        content: '<combat start: player, Ellie, Goblin>',
        meta: resolved,
        status: 'done',
        createdAt: Date.now(),
      })
      .run()
    const nextId = newId()
    const next = stage.applyStageParse(
      chat.id,
      { role: 'assistant', status: 'done', parentId: startId, meta: {} },
      '<combat next>',
    )
    db.insert(messages)
      .values({
        id: nextId,
        chatId: chat.id,
        parentId: startId,
        role: 'assistant',
        content: '<combat next>',
        meta: next,
        status: 'done',
        createdAt: Date.now(),
      })
      .run()
    expect(stage.computeStage(chat.id, chats.loadPath(nextId))?.combat).toMatchObject({ turn: 1, round: 1 })
    expect(stage.computeStage(chat.id, chats.loadPath(startId))?.combat?.turn).toBe(0)
    const continued = stage.applyStageParse(
      chat.id,
      { role: 'assistant', status: 'done', parentId: done.id, meta: resolved },
      '<combat start: player, Ellie, Goblin>\n<completed>',
      () => {
        throw new Error('先攻不应重掷')
      },
    )
    expect(continued.stage?.ops[0]).toEqual(resolved.stage?.ops[0])
    const branch = chats.branchChat(chat.id, startId)
    const page = (await (await request(`/chats/${branch.id}`)).json()) as ChatPage
    expect(page.stage?.combat?.order).toEqual(stage.computeStage(chat.id, chats.loadPath(startId))?.combat?.order)
    model.setScript(() => ({ text: '<combat end>' }))
    const regenerated = await readSSE(
      await request(`/chats/${chat.id}/generate`, { mode: 'regenerate', targetId: done.id }),
    )
    const regeneratedId = regenerated
      .filter((event): event is Extract<GenerateEvent, { type: 'done' }> => event.type === 'done')
      .at(-1)!.message.id
    expect(stage.computeStage(chat.id, chats.loadPath(regeneratedId))?.combat).toBeUndefined()
    expect(stage.computeStage(chat.id, chats.loadPath(done.id))?.combat).toBeDefined()
    for (const data of [plain.data, { ...dnd.data, trpg: { ...dnd.data.trpg, ruleSystem: 'coc7' as const } }]) {
      db.update(playPresets).set({ data }).where(eq(playPresets.id, dnd.id)).run()
      expect(availableTools(chat.id).some(({ tool }) => tool.name === 'ability_check')).toBe(false)
      expect((await runTool('ability_check', '{"skill":"str"}', ctx)).meta?.check).toBeUndefined()
      expect((await request(`/chats/${chat.id}/check`, { skill: 'str', dc: 10 })).status).toBe(400)
    }
    expect(
      ((await (await request(`/personas`)).json()) as PersonaDTO[]).find((p) => p.id === persona.id)?.sheet,
    ).toEqual(sheet)
  } finally {
    model.stop()
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
