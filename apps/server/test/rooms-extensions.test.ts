import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 子进程保证真实的系统库和三套用户库不受测试全局用户上下文影响。
test('MP4 真实用户库：提案、旁观、导出、提醒、异步与转让', async () => {
  if (!process.env.MP4_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, MP4_TEST_CHILD: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'nobot-mp4-'))
  process.env.DATA_DIR = directory
  const { systemDatabase: system } = await import('../src/db/system-client')
  const sys = await import('../src/db/system-schema')
  const { db, newId, getSetting, setSetting } = await import('../src/db/client')
  const schema = await import('../src/db/schema')
  const { runAsUser, currentPaths, closeUserDatabase } = await import('../src/user-context')
  const { eq } = await import('drizzle-orm')
  const shared = await import('@nobot/shared')
  const r = await import('../src/services/rooms')
  const chars = await import('../src/services/rooms/characters')
  const ext = await import('../src/services/rooms/extensions')
  const transfer = await import('../src/services/rooms/transfer')
  const turns = await import('../src/services/rooms/turns')
  const trpg = await import('../src/services/rooms/trpg')
  const { dispatchScope } = await import('../src/services/rooms/scope')
  const { createChat, loadPath, getChatRow } = await import('../src/services/chats')
  const now = Date.now()
  const users = ['alice', 'bob', 'carol'].map((id, i) => ({ id, handle: id, name: id, isAdmin: i === 0 }))
  for (const u of users)
    system()
      .insert(sys.users)
      .values({ ...u, passwordHash: 'unused', createdAt: now })
      .run()
  const owner = <T>(fn: () => T) => runAsUser(users[0]!, fn)
  const guest = <T>(fn: () => T) => runAsUser(users[1]!, fn)
  const observer = <T>(fn: () => T) => runAsUser(users[2]!, fn)
  const setup = (u: (typeof users)[number]) =>
    runAsUser(u, () => {
      const characterId = newId(),
        personaId = newId()
      db.insert(schema.characters)
        .values({
          id: characterId,
          name: `${u.name} AI`,
          description: 'shared description',
          personality: 'SECRET personality',
          scenario: 'SECRET scenario',
          firstMes: 'hello',
          systemPrompt: 'SECRET prompt',
          createdAt: now,
          updatedAt: now,
        })
        .run()
      db.insert(schema.personas)
        .values({ id: personaId, name: u.name, description: 'persona', createdAt: now, updatedAt: now })
        .run()
      return { characterId, personaId, chat: createChat({ characterId }) }
    })
  try {
    const a = setup(users[0]!),
      b = setup(users[1]!),
      c = setup(users[2]!)
    const room = owner(() =>
      r.createRoom(
        shared.createRoomInput.parse({
          chatId: a.chat.id,
          name: 'Room',
          turnMode: 'host',
          allowSpectators: true,
          maxMembers: 2,
          autoResolveWhenReady: false,
          asyncMode: true,
          roundDeadlineHours: 1,
        }),
      ),
    )
    const id = room.id
    const joinRoom = (role: 'player' | 'spectator', personaId: string) => {
      const invite = owner(() => r.createInvite(id, shared.roomInviteInput.parse({ kind: 'link', role })))
      return r.joinRoom(shared.roomJoinInput.parse({ invite: invite.token, personaId, acceptedRulesVersion: 1 }))
    }
    guest(() => joinRoom('player', b.personaId))
    const beforeJoin = owner(() =>
      turns.sendRoomMessage(id, { text: 'old public', channel: 'ooc', clientMessageId: 'old' }),
    )
    await Bun.sleep(3)
    observer(() => joinRoom('spectator', c.personaId))
    expect(observer(() => r.roomDetail(id)).members).toHaveLength(2)
    expect(observer(() => r.roomDetail(id)).spectators).toHaveLength(1)
    const permissions = observer(() => r.roomDetail(id)).permissions
    expect(permissions.isSpectator).toBe(true)
    for (const flag of [
      'canSend',
      'canSendIc',
      'canRoll',
      'canTrigger',
      'canWhisper',
      'canPickChoice',
      'canInvite',
      'canManageRounds',
    ] as const)
      expect(permissions[flag]).toBe(false)
    const scope = (path: string, who = observer, method = 'GET') =>
      who(() => dispatchScope(id, new Request(`http://local/api/rooms/${id}/scope${path}`, { method }), path))
    const send = (text: string, cid = newId()) =>
      guest(() => turns.sendRoomMessage(id, { text, channel: 'ooc', clientMessageId: cid }))
    const publicMessage = send('new public @alice', 'mention-once')
    send('new public @alice', 'mention-once')
    expect(
      system()
        .select()
        .from(sys.notifications)
        .all()
        .filter((n) => n.type === 'room.mention'),
    ).toHaveLength(1)
    for (const action of [
      () => turns.sendRoomMessage(id, { text: 'x', channel: 'ooc', clientMessageId: 'observer' }),
      () => turns.typing(id),
      () => turns.triggerTurn(id),
      () => trpg.readyRoom(id, 'done'),
      () => trpg.rollRoom(id, { expression: '1d6', visibility: 'public' }),
      () => trpg.pickRoomChoice(id, publicMessage.id, 0),
      () => turns.suggest(id, publicMessage.id),
      () => turns.requestTurn(id),
      () => turns.abortTurn(id),
    ])
      expect(() => observer(action)).toThrow()
    await expect(scope(`/chats/${room.chatId}/vars`, observer, 'POST')).rejects.toThrow()
    const secret = guest(() => trpg.whisperRoom(id, { text: 'PRIVATE whisper', to: 'gm', clientMessageId: 'whisper' }))
    for (const visibility of ['self', 'gm', 'blind'] as const)
      guest(() => trpg.rollRoom(id, { expression: '1d6', visibility }))
    const page = (await (await scope(`/chats/${room.chatId}`)).json()) as {
      messages: { id: string; meta: { hidden?: unknown } }[]
    }
    expect(page.messages.map((m) => m.id)).not.toContain(beforeJoin.id)
    expect(page.messages.map((m) => m.id)).not.toContain(secret.id)
    expect(page.messages.every((m) => !m.meta.hidden)).toBe(true)
    expect(page.messages.some((m) => m.id === publicMessage.id)).toBe(true)
    const exported = observer(() => ext.exportRoom(id, 'json'))
    expect(exported).not.toContain('PRIVATE whisper')
    expect(exported).not.toContain(beforeJoin.id)
    expect(exported).not.toContain('hidden')
    expect(exported).toContain(publicMessage.id)
    expect(() => observer(() => ext.exportRoom(id, 'markdown'))).not.toThrow()
    expect(() => observer(() => ext.exportRoom(id, 'json'))).not.toThrow()
    expect(() => observer(() => ext.exportRoom(id, 'markdown'))).toThrow()
    const unread = observer(() => ext.unreadDetails(id))
    expect(unread.count).toBeGreaterThan(0)
    expect(
      unread.firstUnreadMessageId,
      JSON.stringify({ unread, publicMessage, history: observer(() => ext.visibleHistory(id)) }),
    ).toBe(publicMessage.id)
    observer(() => ext.markRead(id, unread.latestSeq))
    expect(observer(() => ext.unreadDetails(id)).count).toBe(0)
    owner(() => r.updateRoom(id, shared.updateRoomInput.parse({ spectatorHistory: 'all' })))
    expect(observer(() => ext.visibleHistory(id)).some((m) => m.id === beforeJoin.id)).toBe(true)
    const sharp = (await import('sharp')).default
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#fff' } })
      .png()
      .toBuffer()
    const { saveAvatar } = await import('../src/lib/files')
    const { saveSprite } = await import('../src/services/sprites/sprites')
    const { readFileSync, existsSync, unlinkSync } = await import('node:fs')
    const avatar = await guest(() => saveAvatar(b.characterId, bytes))
    const sprite = await guest(() => saveSprite(b.characterId, bytes, 'default', 'happy'))
    for (let i = 0; i < 7; i++) await guest(() => saveSprite(b.characterId, bytes, 'default', `extra-${i}`))
    guest(() => {
      db.update(schema.characters)
        .set({
          avatarFile: avatar,
          extensions: { nobot_tts: { engine: 'openai', voice: 'test', speed: 1, apiKey: 'SECRET key' } },
        })
        .where(eq(schema.characters.id, b.characterId))
        .run()
      db.insert(schema.lorebooks).values({ id: 'book', name: 'World', createdAt: now, updatedAt: now }).run()
      db.insert(schema.characterLorebooks).values({ characterId: b.characterId, lorebookId: 'book' }).run()
      db.insert(schema.lorebookEntries)
        .values({
          id: 'entry',
          lorebookId: 'book',
          data: shared.lorebookEntryDataSchema.parse({ content: 'shared world' }),
        })
        .run()
    })
    expect(() =>
      guest(() =>
        chars.proposeCharacter(
          id,
          shared.roomCharacterProposalInput.parse({
            characterId: a.characterId,
            share: {
              description: false,
              personality: false,
              scenario: false,
              exampleDialogue: false,
              sprites: false,
              voice: false,
              lorebook: false,
            },
          }),
        ),
      ),
    ).toThrow()
    const proposal = guest(() =>
      chars.proposeCharacter(
        id,
        shared.roomCharacterProposalInput.parse({
          characterId: b.characterId,
          share: {
            description: true,
            personality: false,
            scenario: false,
            exampleDialogue: false,
            sprites: true,
            voice: true,
            lorebook: true,
          },
          note: 'bring AI',
        }),
      ),
    )
    expect(JSON.stringify(proposal)).not.toContain('SECRET')
    expect(proposal.preview).not.toHaveProperty('personality')
    expect(proposal.preview).not.toHaveProperty('scenario')
    expect(proposal.preview.sprites.count).toBe(8)
    expect(proposal.preview.sprites.thumbnails).toHaveLength(6)
    expect(proposal.preview.sprites.thumbnails.every((url) => url.startsWith('data:image/webp;base64,'))).toBe(true)
    expect(proposal.preview.voice).toBe(true)
    expect(proposal.preview.avatarUrl).toStartWith('data:image/webp;base64,')
    expect(proposal.preview.lorebooks).toEqual([{ name: 'World', entryCount: 1 }])
    expect(JSON.stringify(proposal)).not.toContain(bytes.toString('base64'))
    expect(JSON.stringify(proposal)).not.toContain('shared world')
    const { roomRoutes } = await import('../src/routes/rooms')
    for (const suffix of ['', `/${proposal.id}`]) {
      const response = await owner(() => roomRoutes.request(`/${id}/characters/proposals${suffix}`))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(suffix ? proposal : [proposal])
    }
    expect(() => observer(() => chars.getProposal(id, proposal.id))).toThrow()
    // 提交后修改来源文字、世界书并删除来源立绘，审批仍只能复制提交时的快照。
    guest(() => {
      db.update(schema.characters)
        .set({ description: 'changed after proposal' })
        .where(eq(schema.characters.id, b.characterId))
        .run()
      db.update(schema.lorebookEntries)
        .set({ data: shared.lorebookEntryDataSchema.parse({ content: 'changed world' }) })
        .where(eq(schema.lorebookEntries.id, 'entry'))
        .run()
      unlinkSync(join(currentPaths().sprites, b.characterId, `${sprite.id}.png`))
    })
    expect(observer(() => chars.listProposals(id))).toHaveLength(0)
    expect(() => guest(() => chars.decideProposal(id, proposal.id, true))).toThrow()
    const approved = owner(() => chars.decideProposal(id, proposal.id, true))
    const copyId = approved.copyId!
    expect(copyId).not.toBe(b.characterId)
    expect(approved.preview).toEqual(proposal.preview)
    expect(owner(() => chars.decideProposal(id, proposal.id, true)).preview).toEqual(proposal.preview)
    const copy = owner(() => db.select().from(schema.characters).where(eq(schema.characters.id, copyId)).get()!)
    expect(copy.description).toBe('shared description')
    expect(copy.personality).toBe('')
    expect(copy.systemPrompt).toBe('')
    expect(copy.extensions.nobot_tts).toEqual({ engine: 'openai', voice: 'test', speed: 1 })
    expect(copy.extensions.room).toEqual({ roomId: id, ownerUserId: 'bob', sourceCharacterId: b.characterId })
    owner(() => {
      expect(getChatRow(room.chatId).characterId).toBeNull()
      expect(getChatRow(room.chatId).groupId).toBeTruthy()
      expect(loadPath(getChatRow(room.chatId).activeLeafId).find((m) => m.role === 'assistant')?.speakerId).toBe(
        a.characterId,
      )
      const s = db.select().from(schema.sprites).where(eq(schema.sprites.characterId, copyId)).get()!
      expect(readFileSync(join(currentPaths().sprites, copyId, `${s.id}.${s.ext}`))).toEqual(bytes)
      expect(existsSync(join(currentPaths().avatars, copy.avatarFile!))).toBe(true)
      const link = db
        .select()
        .from(schema.characterLorebooks)
        .where(eq(schema.characterLorebooks.characterId, copyId))
        .get()!
      expect(link.lorebookId).not.toBe('book')
      expect(
        db.select().from(schema.lorebookEntries).where(eq(schema.lorebookEntries.lorebookId, link.lorebookId)).get()
          ?.data.content,
      ).toBe('shared world')
    })
    const full = (await (await scope(`/characters/${copyId}`, guest)).json()) as { extensions?: unknown }
    expect(full.extensions).toBeTruthy()
    const publicCard = (await (await scope(`/characters/${copyId}`)).json()) as { extensions?: unknown }
    expect(publicCard.extensions).toEqual({})
    await expect(scope(`/characters/${copyId}/export`)).rejects.toThrow()
    const pathBefore = owner(() => loadPath(getChatRow(room.chatId).activeLeafId).map((m) => m.id))
    guest(() => chars.withdrawCharacter(id, copyId))
    expect(owner(() => loadPath(getChatRow(room.chatId).activeLeafId).map((m) => m.id))).toEqual(pathBefore)
    expect(
      owner(
        () => db.select().from(schema.groupMembers).where(eq(schema.groupMembers.characterId, copyId)).get()?.muted,
      ),
    ).toBe(true)
    // 原卡后续修改不会写回快照；重新提交仍需重新审批。
    expect(
      guest(
        () => db.select().from(schema.characters).where(eq(schema.characters.id, b.characterId)).get()?.personality,
      ),
    ).toBe('SECRET personality')
    const round = owner(() => trpg.nextRound(r.roomRow(id)))
    owner(() => trpg.reconcileRound(r.roomRow(id), now + 120001))
    expect(owner(() => trpg.roundSnapshot(r.roomRow(id), now + 120001)).members.bob).toBe('pending')
    owner(() => trpg.resumeRoom(r.roomRow(id)))
    const turnNotifications = system()
      .select()
      .from(sys.notifications)
      .all()
      .filter((n) => n.type === 'room.your-turn' && n.userId === 'bob').length
    owner(() => trpg.reconcileRound(r.roomRow(id)))
    expect(
      system()
        .select()
        .from(sys.notifications)
        .all()
        .filter((n) => n.type === 'room.your-turn' && n.userId === 'bob'),
    ).toHaveLength(turnNotifications)
    owner(() => trpg.reconcileRound(r.roomRow(id), round.deadline! + 1))
    expect(owner(() => getSetting<import('@nobot/shared').RoomRoundState>(`room.round:${id}`)?.members.bob)).toBe(
      'passed',
    )
    const session = owner(() =>
      ext.saveSession(
        id,
        shared.roomSessionInput.parse({ title: 'Game', startsAt: now + 7200000, durationMinutes: 120 }),
      ),
    )
    guest(() => ext.rsvp(id, session.id, 'yes'))
    observer(() => ext.rsvp(id, session.id, 'no'))
    expect(guest(() => r.roomDetail(id)).nextSession?.myRsvp).toBe('yes')
    ext.resumeExtensions(r.roomRow(id), now + 5400001)
    ext.resumeExtensions(r.roomRow(id), now + 5400002)
    expect(
      system()
        .select()
        .from(sys.notifications)
        .all()
        .filter((n) => n.type === 'room.session.starting'),
    ).toHaveLength(1)
    expect(
      system()
        .select()
        .from(sys.notifications)
        .all()
        .find((n) => n.type === 'room.session.starting')?.userId,
    ).toBe('bob')
    const restartSession = owner(() =>
      ext.saveSession(
        id,
        shared.roomSessionInput.parse({ title: 'After restart', startsAt: Date.now() + 3600000, durationMinutes: 60 }),
      ),
    )
    guest(() => ext.rsvp(id, restartSession.id, 'maybe'))
    system()
      .update(sys.roomSessions)
      .set({ startsAt: Date.now() + 1799999 })
      .where(eq(sys.roomSessions.id, restartSession.id))
      .run()
    owner(() => {
      const saved = getSetting<import('@nobot/shared').RoomRoundState>(`room.round:${id}`)!
      setSetting(`room.round:${id}`, {
        ...saved,
        deadline: Date.now() - 1,
        members: { ...saved.members, bob: 'pending' },
      })
    })
    closeUserDatabase('alice')
    r.resumeRoomStates()
    r.resumeRoomStates()
    expect(owner(() => getSetting<import('@nobot/shared').RoomRoundState>(`room.round:${id}`)?.members.bob)).toBe(
      'passed',
    )
    expect(
      system()
        .select()
        .from(sys.notifications)
        .all()
        .filter((n) => n.type === 'room.session.starting'),
    ).toHaveLength(2)
    const cancelled = owner(() =>
      ext.saveSession(
        id,
        shared.roomSessionInput.parse({ title: 'Cancelled', startsAt: now + 9000000, durationMinutes: 30 }),
      ),
    )
    owner(() => ext.cancelSession(id, cancelled.id))
    expect(owner(() => ext.listSessions(id)).find((s) => s.id === cancelled.id)?.cancelledAt).toBeTruthy()
    const rejected = guest(() =>
      chars.proposeCharacter(
        id,
        shared.roomCharacterProposalInput.parse({
          characterId: b.characterId,
          share: {
            description: false,
            personality: false,
            scenario: false,
            exampleDialogue: false,
            sprites: false,
            voice: false,
            lorebook: false,
          },
        }),
      ),
    )
    expect(rejected.preview.sprites).toEqual({ count: 0, thumbnails: [] })
    expect(rejected.preview.lorebooks).toEqual([])
    expect(rejected.preview.voice).toBe(false)
    expect(owner(() => chars.decideProposal(id, rejected.id, false)).status).toBe('rejected')
    expect(
      system()
        .select()
        .from(sys.notifications)
        .all()
        .some((n) => n.type === 'room.character.rejected' && n.userId === 'bob'),
    ).toBe(true)
    guest(() => ext.setNotify(id, 'none'))
    const beforeNotify = system().select().from(sys.notifications).all().length
    ext.notifyRoom(r.roomRow(id), 'bob', 'room.mention', 'muted')
    expect(system().select().from(sys.notifications).all()).toHaveLength(beforeNotify)
    guest(() => ext.setNotify(id, 'all'))
    expect(() => guest(() => transfer.transferOffer(id, 'alice'))).toThrow()
    expect(() => owner(() => transfer.transferOffer(id, 'carol'))).toThrow()
    owner(() => transfer.transferOffer(id, 'bob'))
    guest(() => transfer.declineTransfer(id))
    expect(guest(() => transfer.getTransfer(id))).toBeNull()
    owner(() => transfer.transferOffer(id, 'bob'))
    expect(() => guest(() => transfer.acceptTransfer(id))).toThrow()
    expect(r.roomRow(id).hostUserId).toBe('alice')
    guest(() =>
      db
        .insert(schema.apiPresets)
        .values({
          id: 'new-connection',
          name: 'Own',
          baseUrl: 'http://local/v1',
          model: 'test',
          apiKey: 'BOB_KEY',
          createdAt: now,
          updatedAt: now,
        })
        .run(),
    )
    owner(() =>
      db
        .insert(schema.apiPresets)
        .values({
          id: 'old-connection',
          name: 'Old',
          baseUrl: 'http://old/v1',
          model: 'test',
          apiKey: 'ALICE_SECRET',
          createdAt: now,
          updatedAt: now,
        })
        .run(),
    )
    const { saveAttachment } = await import('../src/services/attachments')
    const { saveBackground } = await import('../src/services/backgrounds/backgrounds')
    const attachment = await owner(() => saveAttachment(bytes))
    const background = await owner(() =>
      saveBackground(bytes, { name: 'Room background', source: 'upload', chatId: room.chatId }),
    )
    const branchId = newId()
    const { mockLlm } = await import('./helpers/mockLlm')
    const model = mockLlm()
    model.setScript(() => ({ text: 'The transferred adventure continues.' }))
    guest(() =>
      db.update(schema.apiPresets).set({ baseUrl: model.url }).where(eq(schema.apiPresets.id, 'new-connection')).run(),
    )
    owner(() => {
      db.update(schema.chats)
        .set({ backgroundId: background.id, vars: { quest: 7 } })
        .where(eq(schema.chats.id, room.chatId))
        .run()
      const original = db.select().from(schema.messages).where(eq(schema.messages.id, publicMessage.id)).get()!
      db.update(schema.messages)
        .set({
          meta: {
            ...original.meta,
            images: [attachment],
            ttsCache: [{ key: 'voice', url: '/api/assets/tts-cache/room-voice.mp3' }],
          },
        })
        .where(eq(schema.messages.id, publicMessage.id))
        .run()
      db.insert(schema.messages)
        .values({
          id: branchId,
          chatId: room.chatId,
          parentId: publicMessage.id,
          role: 'assistant',
          content: 'Alternate branch',
          speakerId: a.characterId,
          createdAt: now,
        })
        .run()
      db.insert(schema.bookmarks)
        .values({
          id: newId(),
          chatId: room.chatId,
          messageId: publicMessage.id,
          name: 'Personal bookmark',
          createdAt: now,
        })
        .run()
    })
    await Bun.write(
      owner(() => join(currentPaths().ttsCache, 'room-voice.mp3')),
      'mock audio',
    )
    // 强制缺失素材，确认目录、目标库和原故事均不改变。
    const hostSprite = owner(
      () => db.select().from(schema.sprites).where(eq(schema.sprites.characterId, copyId)).get()!,
    )
    const spritePath = owner(() => join(currentPaths().sprites, copyId, `${hostSprite.id}.${hostSprite.ext}`))
    const spriteBytes = readFileSync(spritePath)
    unlinkSync(spritePath)
    const beforeTarget = guest(() => db.select().from(schema.chats).all().length)
    expect(() => guest(() => transfer.acceptTransfer(id))).toThrow()
    expect(r.roomRow(id).hostUserId).toBe('alice')
    expect(guest(() => db.select().from(schema.chats).all())).toHaveLength(beforeTarget)
    await Bun.write(spritePath, spriteBytes)
    // 数据库插入途中失败也必须回滚已经写入的角色和世界书。
    const { currentContext } = await import('../src/user-context')
    const targetBefore = guest(() => ({
      cards: db.select().from(schema.characters).all().length,
      books: db.select().from(schema.lorebooks).all().length,
    }))
    guest(() =>
      currentContext().sqlite.exec(
        "CREATE TRIGGER mp4_copy_failure BEFORE INSERT ON chats BEGIN SELECT RAISE(ABORT, 'copy failure'); END",
      ),
    )
    expect(() => guest(() => transfer.acceptTransfer(id))).toThrow('copy failure')
    expect(r.roomRow(id).hostUserId).toBe('alice')
    expect(guest(() => db.select().from(schema.characters).all())).toHaveLength(targetBefore.cards)
    expect(guest(() => db.select().from(schema.lorebooks).all())).toHaveLength(targetBefore.books)
    guest(() => currentContext().sqlite.exec('DROP TRIGGER mp4_copy_failure'))
    system().update(sys.roomMembers).set({ acceptedRulesVersion: 0 }).where(eq(sys.roomMembers.roomId, id)).run()
    const moved = guest(() => transfer.acceptTransfer(id))
    expect(moved.permissions.canSend).toBe(true)
    expect(owner(() => r.roomDetail(id)).permissions.canSend).toBe(true)
    expect(moved.hostUserId).toBe('bob')
    expect(moved.chatId).not.toBe(room.chatId)
    expect(owner(() => r.roomDetail(id)).myRole).toBe('gm')
    guest(() => {
      const movedChat = getChatRow(moved.chatId)
      expect(movedChat.apiPresetId).toBe('new-connection')
      expect(movedChat.vars).toEqual({ quest: 7 })
      expect(movedChat.backgroundId).not.toBe(background.id)
      expect(
        db
          .select()
          .from(schema.messages)
          .all()
          .some((m) => m.chatId === moved.chatId && m.content === 'Alternate branch'),
      ).toBe(true)
      expect(
        db
          .select()
          .from(schema.bookmarks)
          .all()
          .some((m) => m.chatId === moved.chatId),
      ).toBe(false)
      const movedPublic = loadPath(movedChat.activeLeafId).find((m) => m.content === publicMessage.content)!
      const image = movedPublic.meta.images![0]!
      expect(image.id).not.toBe(attachment.id)
      expect(existsSync(join(currentPaths().attachments, `${image.id}.webp`))).toBe(true)
      expect(existsSync(join(currentPaths().attachments, `${image.id}.json`))).toBe(true)
      const voice = movedPublic.meta.ttsCache![0]!
      expect(voice.url).not.toBe('/api/assets/tts-cache/room-voice.mp3')
      expect(existsSync(join(currentPaths().ttsCache, voice.url.split('/').at(-1)!))).toBe(true)
      expect(loadPath(movedChat.activeLeafId).map((m) => m.content)).toEqual(
        owner(() => loadPath(getChatRow(room.chatId).activeLeafId).map((m) => m.content)),
      )
      expect(
        db
          .select()
          .from(schema.apiPresets)
          .all()
          .some((x) => x.apiKey === 'ALICE_SECRET'),
      ).toBe(false)
    })
    expect(guest(() => transfer.acceptTransfer(id)).chatId).toBe(moved.chatId)
    expect(
      system()
        .select()
        .from(sys.rooms)
        .all()
        .some((x) => x.chatId === room.chatId),
    ).toBe(false)
    const continuation = owner(() =>
      turns.sendRoomMessage(id, { text: 'continued after transfer', channel: 'ooc', clientMessageId: 'continued' }),
    )
    expect(continuation.chatId).toBe(moved.chatId)
    expect(owner(() => getChatRow(room.chatId).activeLeafId)).not.toBe(continuation.id)
    expect(guest(() => getChatRow(moved.chatId).activeLeafId)).toBe(continuation.id)
    const generation = await import('../src/services/generation/generation')
    try {
      guest(() => turns.triggerTurn(id))
      while (guest(() => generation.isGenerating(moved.chatId))) await Bun.sleep(5)
      expect(guest(() => loadPath(getChatRow(moved.chatId).activeLeafId).at(-1)?.content)).toBe(
        'The transferred adventure continues.',
      )
      expect(model.receivedHeaders.at(-1)?.get('authorization')).toBe('Bearer BOB_KEY')
      expect(guest(() => ext.unreadDetails(id)).latestSeq).toBeGreaterThan(0)
    } finally {
      await model.stop()
    }
    expect(
      owner(() =>
        db
          .select()
          .from(schema.bookmarks)
          .all()
          .some((x) => x.chatId === room.chatId),
      ),
    ).toBe(true)
    expect(sprite.id).toBeTruthy()
  } finally {
    for (const u of users) closeUserDatabase(u.handle)
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
