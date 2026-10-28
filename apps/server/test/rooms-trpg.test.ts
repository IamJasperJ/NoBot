import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LiveEnvelope, MessageDTO } from '@nobot/shared'

// 子进程隔离真实用户数据库，避免测试用默认用户上下文掩盖权限漏洞。
test('MP3：骰点可见性、私信、回合持久化、先攻与选项状态机', async () => {
  if (!process.env.MP3_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, MP3_TEST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, out + err).toBe(0)
    return
  }
  delete (globalThis as typeof globalThis & { __NOBOT_TEST_USER__?: string }).__NOBOT_TEST_USER__
  const directory = await mkdtemp(join(tmpdir(), 'nobot-mp3-'))
  process.env.DATA_DIR = directory
  const { systemDatabase } = await import('../src/db/system-client')
  const { users, roomMembers } = await import('../src/db/system-schema')
  const { db, newId, getSetting } = await import('../src/db/client')
  const { characters, personas, messages, chats, roomEvents, playPresets } = await import('../src/db/schema')
  const { runAsUser, closeUserDatabase } = await import('../src/user-context')
  const { eq, and } = await import('drizzle-orm')
  const r = await import('../src/services/rooms')
  const trpg = await import('../src/services/rooms/trpg')
  const turns = await import('../src/services/rooms/turns')
  const { roomMessage } = await import('../src/services/rooms/dto')
  const { registerTtsRoutes } = await import('../src/extensions/builtin/audio/tts/routes')
  const { Hono } = await import('hono')
  const audio = new Hono()
  const { HttpError } = await import('../src/errors')
  audio.onError((error, c) => c.json({ error: error.message }, error instanceof HttpError ? error.status : 500))
  registerTtsRoutes(audio, { settings: {}, storage: { get: () => undefined, set: () => {}, delete: () => {} } })
  const { dispatchScope } = await import('../src/services/rooms/scope')
  const { liveHub } = await import('../src/services/live/hub')
  const { createChat, loadMessage, loadPath } = await import('../src/services/chats')
  const { loadGenerationContext, toHistory } = await import('../src/services/generation/context')
  const { listNotifications } = await import('../src/services/social')
  const { createRoomInput, updateRoomInput, roomRollInput, roomWhisperInput } = await import('@nobot/shared')
  const { mockLlm } = await import('./helpers/mockLlm')
  const { createApiPreset } = await import('../src/services/connections')
  const { apiPresetInput } = await import('@nobot/shared')
  const generation = await import('../src/services/generation/generation')
  const model = mockLlm()
  model.setScript(() => ({ text: 'Resolved', delayMs: 3 }))
  const now = Date.now()
  const people = ['owner', 'gm', 'author', 'other'].map((id) => ({ id, handle: id, name: id, isAdmin: false }))
  const [owner, gm, author, other] = people
  const as = <T>(id: string, fn: () => T) => runAsUser(people.find((u) => u.id === id)!, fn)
  for (const user of people)
    systemDatabase()
      .insert(users)
      .values({ ...user, passwordHash: 'unused', createdAt: now })
      .run()
  let roomId = '',
    chatId = '',
    characterId = ''
  const scope = (userId: string, path: string, method = 'GET', body?: unknown) =>
    as(userId, () =>
      dispatchScope(
        roomId,
        new Request(`http://local${path}`, {
          method,
          ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
        }),
        path,
      ),
    )
  const collected = Object.fromEntries(people.map((u) => [u.id, [] as LiveEnvelope[]]))
  const registrations = people.map((u) =>
    liveHub.register(
      u.id,
      (e) => collected[u.id]!.push(e),
      () => {},
    ),
  )
  try {
    const room = as(owner!.id, () => {
      createApiPreset(apiPresetInput.parse({ name: 'Mock MP3', baseUrl: model.url, model: 'mock-one' }))
      characterId = newId()
      const personaId = newId()
      db.insert(characters)
        .values({ id: characterId, name: 'GM AI', firstMes: 'Welcome', createdAt: now, updatedAt: now })
        .run()
      db.insert(personas).values({ id: personaId, name: 'Owner', createdAt: now, updatedAt: now }).run()
      chatId = createChat({ characterId }).id
      return r.createRoom(
        createRoomInput.parse({ chatId, name: 'Campaign', turnMode: 'host', personaId, autoResolveWhenReady: false }),
      )
    })
    roomId = room.id
    for (const user of [gm!, author!, other!])
      systemDatabase()
        .insert(roomMembers)
        .values({
          roomId,
          userId: user.id,
          role: user.id === 'gm' ? 'gm' : 'player',
          personaName: user.name,
          personaDescription: '',
          acceptedRulesVersion: 1,
          joinedAt: now,
        })
        .run()
    for (const registration of registrations) await registration.join(`room:${roomId}`, () => true)
    const ids: string[] = []
    for (const visibility of ['public', 'gm', 'blind', 'self'] as const) {
      const rolled = as('author', () =>
        trpg.rollRoom(roomId, roomRollInput.parse({ expression: '1d20', visibility }), () => 0.95),
      )
      ids.push(rolled.message.id)
      const source = as('owner', () => loadMessage(rolled.message.id))
      expect(source.content).toContain('20')
      expect(source.meta.author?.userId).toBe('author')
      for (const user of people) {
        const sees =
          visibility === 'public' ||
          (visibility === 'gm' && ['owner', 'gm', 'author'].includes(user.id)) ||
          (visibility === 'blind' && ['owner', 'gm'].includes(user.id)) ||
          (visibility === 'self' && user.id === 'author')
        const page = await (await scope(user.id, `/chats/${chatId}`)).json()
        const dto = page.messages.find((m: MessageDTO) => m.id === source.id) as MessageDTO
        if (user.id === 'owner') {
          const { chatRoutes } = await import('../src/routes/chats')
          const normal = await as('owner', () => chatRoutes.request(`/${chatId}`))
          const normalPage = await normal.json()
          expect(!normalPage.messages.find((m: MessageDTO) => m.id === source.id).meta.hidden).toBe(sees)
        }
        const event = collected[user.id]!.filter((e) => e.type === 'room.message').at(-1)?.data as {
          payload: { message: MessageDTO }
        }
        const stored = as(
          'owner',
          () =>
            db
              .select()
              .from(roomEvents)
              .where(and(eq(roomEvents.roomId, roomId), eq(roomEvents.entityId, source.id)))
              .get()!,
        )
        const replay = r.projectRoomEvent(stored, user.id)
        for (const projected of [
          dto,
          event.payload.message,
          replay.payload.message as MessageDTO,
          roomMessage(source, user.id, 'owner'),
        ]) {
          expect(!projected.meta.hidden).toBe(sees)
          if (sees) expect(projected.content).toBe(source.content)
          else {
            expect(JSON.stringify(projected)).not.toContain('1d20')
            expect(projected.meta.check).toBeUndefined()
            expect(projected.parentId).toBe(source.parentId)
          }
        }
        if (!sees && user.id === 'owner') {
          for (const endpoint of ['message', 'line']) {
            const response = await as('owner', () =>
              audio.request(`/tts/${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chatId,
                  messageId: source.id,
                  text: source.content,
                  speaker: { kind: 'narrator' },
                }),
              }),
            )
            expect(response.status).toBe(404)
          }
          const bookmarks = await import('../src/services/bookmarks')
          expect(() => as('owner', () => bookmarks.createBookmark(chatId, { messageId: source.id }))).toThrow()
          expect(() => as('owner', () => bookmarks.createSave(chatId, { messageId: source.id }))).toThrow()
        }
        if (!sees)
          await expect(
            scope(user.id, '/ext/audio/tts/line', 'POST', {
              chatId,
              messageId: source.id,
              text: 'secret',
              speaker: { kind: 'narrator' },
            }),
          ).rejects.toThrow()
      }
      const history = as('owner', () =>
        toHistory(loadGenerationContext(chatId, { requireConnection: false }), source.id),
      )
      expect(history.some((m) => m.id === source.id)).toBe(visibility !== 'self')
    }
    expect(as('owner', () => turns.turnState(roomId).pending)).toHaveLength(0)
    const whisper = as('author', () =>
      trpg.whisperRoom(
        roomId,
        roomWhisperInput.parse({ text: 'PRIVATE WHISPER', to: 'gm', clientMessageId: 'whisper' }),
      ),
    )
    expect(whisper.meta.excluded).toBe(true)
    expect(
      as('author', () =>
        trpg.whisperRoom(roomId, roomWhisperInput.parse({ text: 'duplicate', to: 'gm', clientMessageId: 'whisper' })),
      ).id,
    ).toBe(whisper.id)
    const reply = as('gm', () =>
      trpg.whisperRoom(roomId, roomWhisperInput.parse({ text: 'GM REPLY', to: 'author', clientMessageId: 'reply' })),
    )
    expect(reply.meta.visibility?.userIds).not.toContain('owner')
    expect(JSON.stringify(collected.owner)).not.toContain('GM REPLY')
    expect(() =>
      as('author', () =>
        trpg.whisperRoom(roomId, roomWhisperInput.parse({ text: 'bad', to: 'other', clientMessageId: 'bad' })),
      ),
    ).toThrow()
    expect(JSON.stringify(collected.other)).not.toContain('PRIVATE WHISPER')
    expect(JSON.stringify(collected.other)).not.toContain('GM REPLY')
    expect(JSON.stringify(listNotifications('gm'))).not.toContain('PRIVATE WHISPER')
    expect(
      listNotifications('gm').items.some(
        (n) => n.type === 'room.whisper' && n.payload.roomId === roomId && n.payload.text === undefined,
      ),
    ).toBe(true)
    expect(
      as('owner', () => toHistory(loadGenerationContext(chatId, { requireConnection: false }), reply.id)).some((m) =>
        m.content.includes('WHISPER'),
      ),
    ).toBe(false)
    expect(as('owner', () => turns.turnState(roomId).pending)).toHaveLength(0)
    const state1 = as('author', () => trpg.readyRoom(roomId, 'done', now))
    expect(state1.members.author).toBe('done')
    as('other', () => trpg.readyRoom(roomId, 'passed', now))
    const saved = as('owner', () => getSetting(`room.round:${roomId}`))
    closeUserDatabase('owner')
    expect(as('owner', () => getSetting(`room.round:${roomId}`))).toEqual(saved)
    expect(as('owner', () => trpg.roundSnapshot(r.roomRow(roomId), now + 120001)).members.author).toBe('away')
    expect(as('gm', () => trpg.skipRound(roomId, 'author')).members.author).toBe('passed')
    expect(as('gm', () => trpg.advanceRound(roomId)).round).toBe(2)
    expect(() => as('author', () => trpg.advanceRound(roomId))).toThrow()
    as('owner', () => r.updateRoom(roomId, updateRoomInput.parse({ turnMode: 'initiative' })))
    as('gm', () =>
      trpg.setInitiative(roomId, {
        order: [
          { kind: 'member', id: 'author' },
          { kind: 'member', id: 'other' },
        ],
      }),
    )
    const send = (userId: string, channel: 'ic' | 'ooc', key: string) =>
      as(userId, () => turns.sendRoomMessage(roomId, { text: key, channel, clientMessageId: key }))
    expect(() => send('other', 'ic', 'wrong-turn')).toThrow('还没有轮到你行动')
    send('other', 'ooc', 'allowed-ooc')
    send('author', 'ic', 'action')
    expect(as('owner', () => trpg.initiativeSnapshot(r.roomRow(roomId))).current).toBe(1)
    expect(send('author', 'ic', 'action').id).toBeTruthy()
    as('other', () => trpg.readyRoom(roomId, 'passed'))
    expect(as('owner', () => r.roomDetail(roomId)).round.round).toBe(3)
    as('gm', () =>
      trpg.setInitiative(roomId, {
        order: [
          { kind: 'member', id: 'author' },
          { kind: 'member', id: 'other' },
        ],
        current: 1,
      }),
    )
    as('gm', () => trpg.skipInitiative(roomId))
    expect(as('owner', () => r.roomDetail(roomId)).initiative.current).toBe(0)
    expect(() => as('author', () => trpg.setInitiative(roomId, { order: [] }))).toThrow()
    expect(() =>
      as('gm', () => trpg.setInitiative(roomId, { order: [{ kind: 'character', id: 'PRIVATE' }] })),
    ).toThrow()
    as('owner', () => r.updateRoom(roomId, updateRoomInput.parse({ turnMode: 'host', choiceMode: 'gm' })))
    function choiceMessage() {
      return as('owner', () => {
        const id = newId()
        db.insert(messages)
          .values({
            id,
            chatId,
            parentId: createChatLeaf(),
            role: 'assistant',
            content: 'Choose',
            createdAt: Date.now(),
            meta: { stage: { choices: [{ text: 'A' }, { text: 'B' }] } },
          })
          .run()
        db.update(chats).set({ activeLeafId: id }).where(eq(chats.id, chatId)).run()
        return id
      })
    }
    function createChatLeaf() {
      return db.select().from(chats).where(eq(chats.id, chatId)).get()!.activeLeafId
    }
    const gmChoice = choiceMessage()
    expect(() => as('author', () => trpg.pickRoomChoice(roomId, gmChoice, 0))).toThrow()
    as('gm', () => trpg.pickRoomChoice(roomId, gmChoice, 1))
    as('owner', () => r.updateRoom(roomId, updateRoomInput.parse({ choiceMode: 'vote' })))
    async function settledVote(messageId: string, before: number) {
      while (as('owner', () => generation.isGenerating(chatId))) await Bun.sleep(5)
      expect(model.requests.length).toBe(before + 1)
      as('owner', () => trpg.closeChoice(roomId, messageId))
      await Bun.sleep(5)
      expect(model.requests.length).toBe(before + 1)
    }
    let requestCount = model.requests.length
    const voted = choiceMessage()
    as('author', () => trpg.pickRoomChoice(roomId, voted, 1))
    expect(() => as('author', () => trpg.pickRoomChoice(roomId, voted, 0))).toThrow()
    as('other', () => trpg.pickRoomChoice(roomId, voted, 1))
    const majority = as('owner', () => trpg.choiceSnapshot(roomId, voted))
    expect(majority).toMatchObject({ closed: true, winner: 1, counts: [0, 2] })
    const winnerMessage = as('owner', () =>
      loadPath(createChatLeaf()).findLast((m) => m.meta.choice?.messageId === voted),
    )!
    expect(winnerMessage.role).toBe('system')
    expect(winnerMessage.speakerId).toBeNull()
    expect(winnerMessage.meta.author).toBeUndefined()
    expect(winnerMessage.content).toContain('B')
    expect(winnerMessage.content).toContain('0, 2')
    expect(
      as('owner', () => toHistory(loadGenerationContext(chatId, { requireConnection: false }), winnerMessage.id)).at(-1)
        ?.content,
    ).toContain('Room vote counts by option: 1=0, 2=2')
    await settledVote(voted, requestCount)
    requestCount = model.requests.length
    const tie = choiceMessage()
    as('author', () => trpg.pickRoomChoice(roomId, tie, 0))
    as('other', () => trpg.pickRoomChoice(roomId, tie, 1))
    expect(as('owner', () => trpg.choiceSnapshot(roomId, tie)).closed).toBe(false)
    expect(as('gm', () => trpg.closeChoice(roomId, tie, undefined, () => 0.99)).winner).toBe(1)
    expect(
      as('owner', () => loadPath(createChatLeaf())).findLast((m) => m.meta.choice?.messageId === tie)?.content,
    ).toContain('平票')
    await settledVote(tie, requestCount)
    requestCount = model.requests.length
    const early = choiceMessage()
    as('author', () => trpg.pickRoomChoice(roomId, early, 0))
    as('owner', () => {
      turns.turnState(roomId).running = true
    })
    expect(() => as('gm', () => trpg.closeChoice(roomId, early))).toThrow('房间正在生成回复')
    expect(as('owner', () => trpg.choiceSnapshot(roomId, early)).closed).toBe(false)
    as('owner', () => {
      turns.turnState(roomId).running = false
    })
    expect(as('gm', () => trpg.closeChoice(roomId, early)).winner).toBe(0)
    await settledVote(early, requestCount)
    as('owner', () => r.updateRoom(roomId, updateRoomInput.parse({ choiceMode: 'each' })))
    const each = choiceMessage()
    const picked = as('author', () => trpg.pickRoomChoice(roomId, each, 0)) as MessageDTO
    expect(picked.meta.author?.userId).toBe('author')
    as('other', () => trpg.pickRoomChoice(roomId, each, 1))
    expect(as('owner', () => trpg.choiceSnapshot(roomId, each)).picks).toEqual(['author', 'other'])
    expect(() => as('author', () => trpg.pickRoomChoice(roomId, each, 1))).toThrow()
    await expect(scope('author', '/ext/image-gen/generate', 'POST', { chatId })).rejects.toThrow()
    expect(collected.author!.some((e) => e.type === 'room.round')).toBe(true)
    expect(collected.author!.some((e) => e.type === 'room.initiative')).toBe(true)
    expect(collected.author!.some((e) => e.type === 'room.choice')).toBe(true)
    expect(ids).toHaveLength(4)
    as('owner', () => r.updateRoom(roomId, updateRoomInput.parse({ choiceMode: 'vote', voteTimeoutSeconds: 1 })))
    const timed = choiceMessage()
    as('author', () => trpg.pickRoomChoice(roomId, timed, 0))
    requestCount = model.requests.length
    await Bun.sleep(1100)
    expect(as('owner', () => trpg.choiceSnapshot(roomId, timed))).toMatchObject({ closed: true, winner: 0 })
    await settledVote(timed, requestCount)
    const restored = choiceMessage()
    as('author', () => trpg.pickRoomChoice(roomId, restored, 0))
    const deadline = as('owner', () => trpg.choiceSnapshot(roomId, restored)).deadline
    closeUserDatabase('owner')
    requestCount = model.requests.length
    // 注入重启恢复时钟，直接恢复到已过截止时间；回调在请求用户上下文之外执行。
    as('owner', () => trpg.restoreChoices(r.roomRow(roomId), deadline + 1))
    await Bun.sleep(20)
    expect(as('owner', () => trpg.choiceSnapshot(roomId, restored))).toMatchObject({ closed: true, winner: 0 })
    await settledVote(restored, requestCount)
    const { playPresetDataSchema } = await import('@nobot/shared')
    as('owner', () => {
      const playId = newId()
      db.insert(playPresets)
        .values({
          id: playId,
          name: 'TRPG',
          data: playPresetDataSchema.parse({ directives: { enabled: true }, trpg: { ruleSystem: 'dnd5e' } }),
          createdAt: now,
          updatedAt: now,
        })
        .run()
      db.update(chats).set({ playPresetId: playId }).where(eq(chats.id, chatId)).run()
    })
    const checked = as('author', () =>
      trpg.checkRoom(roomId, { skill: 'perception', dc: 12, who: 'GM AI', visibility: 'self' }, () => 0.95),
    )
    expect(checked).toHaveProperty('who', 'author')
    const checkLeaf = as('owner', () => loadMessage(createChatLeaf()!))
    expect(checkLeaf.meta.visibility?.level).toBe('self')
    expect(checkLeaf.meta.excluded).toBe(true)
    const hiddenCheck = await (
      await scope('author', `/chats/${chatId}/check`, 'POST', { skill: 'perception', dc: 12, visibility: 'blind' })
    ).json()
    expect(hiddenCheck).toEqual({ hidden: true })
    const { getChatRow } = await import('../src/services/chats')
    try {
      as('owner', () =>
        createApiPreset(apiPresetInput.parse({ name: 'Mock MP3', baseUrl: model.url, model: 'mock-one' })),
      )
      model.setScript(() => ({ text: 'Resolved', delayMs: 3 }))
      as('owner', () => r.updateRoom(roomId, updateRoomInput.parse({ autoResolveWhenReady: true, turnMode: 'host' })))
      send('author', 'ic', 'ready-after-votes')
      const beforeRound = as('owner', () => r.roomDetail(roomId)).round.round
      as('author', () => trpg.readyRoom(roomId, 'done'))
      as('other', () => trpg.readyRoom(roomId, 'passed'))
      expect(as('owner', () => generation.isGenerating(chatId))).toBe(true)
      while (as('owner', () => generation.isGenerating(chatId))) await Bun.sleep(5)
      expect(as('owner', () => r.roomDetail(roomId)).round.round).toBe(beforeRound + 1)
      as('owner', () => r.updateRoom(roomId, updateRoomInput.parse({ turnMode: 'initiative' })))
      as('gm', () =>
        trpg.setInitiative(roomId, {
          order: [
            { kind: 'member', id: 'author' },
            { kind: 'character', id: characterId },
            { kind: 'member', id: 'other' },
          ],
        }),
      )
      send('author', 'ic', 'initiative-ai')
      await Bun.sleep(10)
      while (as('owner', () => generation.isGenerating(chatId))) await Bun.sleep(5)
      const aiMessage = as('owner', () =>
        loadPath(getChatRow(chatId).activeLeafId).findLast((m) => m.role === 'assistant'),
      )!
      expect(aiMessage.speakerId).toBe(characterId)
      expect(as('owner', () => r.roomDetail(roomId)).initiative.current).toBe(2)
      as('other', () => trpg.readyRoom(roomId, 'passed'))
      expect(as('owner', () => r.roomDetail(roomId)).initiative.current).toBe(0)
    } finally {
      model.stop()
    }
  } finally {
    model.stop()
    for (const registration of registrations) registration.dispose()
    for (const user of people) closeUserDatabase(user.id)
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
