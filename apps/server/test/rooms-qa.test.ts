import { afterAll, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.ROOM_QA_CHILD) {
  test('房间 QA 回归（独立用户库）', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rooms-qa-'))
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, ROOM_QA_CHILD: '1', DATA_DIR: directory },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    await rm(directory, { recursive: true, force: true })
    expect(code, out + err).toBe(0)
  }, 60000)
} else {
  delete (globalThis as typeof globalThis & { __NOBOT_TEST_USER__?: string }).__NOBOT_TEST_USER__
  process.env.DATA_DIR ??= await mkdtemp(join(tmpdir(), 'rooms-qa-'))
  const shared = await import('@nobot/shared')
  const { eq } = await import('drizzle-orm')
  const { systemDatabase } = await import('../src/db/system-client')
  const { users, roomMembers, roomInvites, sessions } = await import('../src/db/system-schema')
  const { db, newId, setSetting } = await import('../src/db/client')
  const { characters, personas, messages, roomEvents } = await import('../src/db/schema')
  const { runAsUser, closeUserDatabase } = await import('../src/user-context')
  const { createChat } = await import('../src/services/chats')
  const r = await import('../src/services/rooms')
  const turns = await import('../src/services/rooms/turns')
  const trpg = await import('../src/services/rooms/trpg')
  const ext = await import('../src/services/rooms/extensions')
  const social = await import('../src/services/social')
  const { liveHub } = await import('../src/services/live/hub')
  const { hashToken } = await import('../src/services/auth')
  const { createServer } = await import('../src/server')
  const people = ['owner', 'player', 'spectator', 'outsider'].map((id) => ({
    id,
    handle: id,
    name: id,
    isAdmin: id === 'owner',
  }))
  for (const person of people)
    systemDatabase()
      .insert(users)
      .values({ ...person, passwordHash: 'unused', createdAt: Date.now() })
      .run()
  const as = <T>(index: number, fn: () => T) => runAsUser(people[index]!, fn)
  const personaIds = people.map((_, i) =>
    as(i, () => {
      const id = newId()
      db.insert(personas).values({ id, name: people[i]!.name, createdAt: Date.now(), updatedAt: Date.now() }).run()
      return id
    }),
  )
  function fixture() {
    return as(0, () => {
      const characterId = newId()
      db.insert(characters).values({ id: characterId, name: 'AI', createdAt: Date.now(), updatedAt: Date.now() }).run()
      const chat = createChat({ characterId })
      const room = r.createRoom(
        shared.createRoomInput.parse({ chatId: chat.id, name: 'QA', turnMode: 'host', allowSpectators: true }),
      )
      for (const i of [1, 2])
        systemDatabase()
          .insert(roomMembers)
          .values({
            roomId: room.id,
            userId: people[i]!.id,
            role: i === 1 ? 'player' : 'spectator',
            personaName: people[i]!.name,
            personaDescription: '',
            acceptedRulesVersion: room.rulesVersion,
            joinedAt: Date.now(),
          })
          .run()
      return room
    })
  }
  const fail = (fn: () => unknown, code: string, status?: number) => {
    let error: unknown
    try {
      fn()
    } catch (e) {
      error = e
    }
    expect(error).toMatchObject({ code, ...(status ? { status } : {}) })
  }
  afterAll(async () => {
    for (const person of people) closeUserDatabase(person.id)
  })

  test('BUG-18：编辑内容、历史与频率有界', () => {
    const room = fixture()
    const m = as(1, () =>
      turns.sendRoomMessage(
        room.id,
        shared.roomSendInput.parse({ text: 'x'.repeat(10000), channel: 'ooc', clientMessageId: 'first' }),
      ),
    )
    for (const content of ['', '  ', 'x'.repeat(100001)])
      fail(() => as(1, () => turns.editRoomMessage(room.id, m.id, content)), 'VALIDATION', 400)
    for (let i = 0; i < 12; i++) as(1, () => turns.editRoomMessage(room.id, m.id, `${i}`))
    const edited = as(1, () => turns.editRoomMessage(room.id, m.id, 'last'))
    expect(edited.meta.edits).toHaveLength(10)
    expect(edited.meta.edits!.every((e) => e.content.length <= 4000)).toBe(true)
    for (let i = 0; i < 16; i++) as(1, () => turns.editRoomMessage(room.id, m.id, `${i}`))
    fail(() => as(1, () => turns.editRoomMessage(room.id, m.id, 'limited')), 'RATE_LIMITED', 429)
  })
  test('BUG-18：房间其他可写文字有长度上限', () => {
    for (const input of [
      { name: 'x'.repeat(101) },
      { description: 'x'.repeat(4001) },
      { contentNotes: 'x'.repeat(4001) },
      { rules: 'x'.repeat(8001) },
      { coverAsset: 'x'.repeat(4001) },
    ])
      expect(shared.updateRoomInput.safeParse(input).success).toBe(false)
    expect(shared.roomPersonaInput.safeParse({ name: 'x'.repeat(101) }).success).toBe(false)
    expect(
      shared.roomSessionInput.safeParse({ title: 'x'.repeat(201), startsAt: Date.now(), durationMinutes: 30 }).success,
    ).toBe(false)
  })
  test('BUG-1：移除当前末位玩家推进轮次，旧先攻不阻断设置保存', () => {
    const room = fixture()
    as(0, () =>
      trpg.setInitiative(room.id, {
        order: [
          { kind: 'member', id: 'owner' },
          { kind: 'member', id: 'player' },
        ],
        current: 1,
      }),
    )
    as(0, () => r.removeMember(room.id, 'player', 'kicked'))
    const detail = as(0, () => r.roomDetail(room.id))
    expect(detail.initiative).toEqual({ order: [{ kind: 'member', id: 'owner' }], current: 0 })
    expect(detail.round.round).toBe(2)
    as(0, () => setSetting(`room.initiative:${room.id}`, { order: [{ kind: 'member', id: 'missing' }], current: 0 }))
    expect(as(0, () => r.updateRoom(room.id, { name: 'saved' })).name).toBe('saved')
  })
  test('BUG-1：离开、踢出、封禁覆盖先攻当前位置前后和空序列', () => {
    for (const action of ['left', 'kicked', 'banned'] as const) {
      for (const current of [0, 1, 2]) {
        const room = fixture()
        as(0, () =>
          trpg.setInitiative(room.id, {
            order: [
              { kind: 'member', id: 'owner' },
              { kind: 'member', id: 'player' },
              { kind: 'character', id: as(0, () => db.select().from(characters).all().at(-1)!.id) },
            ],
            current,
          }),
        )
        // 避免角色项启动后台生成，本用例只检查游标裁剪。
        as(0, () => r.updateRoom(room.id, { status: 'paused' }))
        as(action === 'left' ? 1 : 0, () => r.removeMember(room.id, 'player', action))
        const state = as(0, () => r.roomDetail(room.id)).initiative
        expect(state.order.some((e) => e.id === 'player')).toBe(false)
        expect(state.current).toBe(current === 0 ? 0 : 1)
      }
    }
  })
  test('BUG-1：提交后的通知故障不能使设置接口失败，并记录日志', () => {
    const room = fixture()
    const notification = spyOn(trpg, 'resumeRoom').mockImplementation(() => {
      throw new Error('notification failure')
    })
    try {
      expect(as(0, () => r.updateRoom(room.id, { name: 'committed' })).name).toBe('committed')
    } finally {
      notification.mockRestore()
    }
  })
  test('BUG-2 / BUG-4：规则编辑者自动接受，人数下限排除旁观者', () => {
    const room = fixture()
    expect(as(0, () => r.updateRoom(room.id, { rules: 'new' })).permissions.canSend).toBe(true)
    fail(() => as(0, () => r.updateRoom(room.id, { maxMembers: 1 })), 'ROOM_CAPACITY_TOO_SMALL', 400)
    expect(as(0, () => r.updateRoom(room.id, { maxMembers: 2 })).maxMembers).toBe(2)
  })
  test('BUG-19：历史、事件和导出不泄露修订，作者可见', () => {
    const room = fixture()
    const message = as(1, () =>
      turns.sendRoomMessage(
        room.id,
        shared.roomSendInput.parse({ text: 'old-secret', channel: 'ooc', clientMessageId: 'privacy' }),
      ),
    )
    as(1, () => turns.editRoomMessage(room.id, message.id, 'new'))
    expect(JSON.stringify(as(2, () => ext.visibleHistory(room.id)))).not.toContain('old-secret')
    expect(JSON.stringify(as(1, () => ext.visibleHistory(room.id)))).toContain('old-secret')
    expect(as(2, () => ext.exportRoom(room.id, 'json'))).not.toContain('old-secret')
    const original = as(
      0,
      () =>
        db
          .select()
          .from(roomEvents)
          .where(eq(roomEvents.roomId, room.id))
          .all()
          .find((e) => e.type === 'room.message')!,
    )
    expect(JSON.stringify(r.projectRoomEvent(original, 'spectator'))).not.toContain('old-secret')
    as(1, () => turns.editRoomMessage(room.id, message.id, null))
    expect(JSON.stringify(r.projectRoomEvent(original, 'spectator'))).not.toContain('new')
    expect(JSON.stringify(r.projectRoomEvent(original, 'owner'))).toContain('old-secret')
  })
  test('BUG-3：拒绝冷却只约束请求方，并给出剩余秒数', () => {
    social.requestFriend('player', 'outsider')
    social.respondFriend('outsider', 'player', 'reject')
    fail(() => social.requestFriend('player', 'outsider'), 'SOCIAL_COOLDOWN', 429)
    expect(() => social.requestFriend('outsider', 'player')).not.toThrow()
  })
  test('BUG-5：拒绝向旁观者发送私信', () => {
    const room = fixture()
    fail(
      () => as(0, () => trpg.whisperRoom(room.id, { to: 'spectator', text: 'private', clientMessageId: 'whisper' })),
      'WHISPER_SPECTATOR',
      400,
    )
  })
  test('BUG-7/8/9/UX-5：失效邀请重入、邀请状态、无效人设和直接邀请校验', async () => {
    const room = fixture()
    const invite = as(0, () => r.createInvite(room.id, shared.roomInviteInput.parse({ kind: 'link', maxUses: 1 })))
    systemDatabase().update(roomInvites).set({ uses: 1 }).where(eq(roomInvites.id, invite.id)).run()
    expect(
      as(1, () => r.joinRoom({ invite: invite.token!, personaId: personaIds[1]!, acceptedRulesVersion: 1 })).id,
    ).toBe(room.id)
    expect(as(1, () => r.lobby(invite.token!))).toMatchObject({ alreadyInRoom: true, room: { id: room.id } })
    fail(
      () => as(3, () => r.joinRoom({ invite: invite.token!, personaId: personaIds[3]!, acceptedRulesVersion: 1 })),
      'NOT_FOUND',
      404,
    )
    const active = as(0, () => r.createInvite(room.id, shared.roomInviteInput.parse({ kind: 'link' })))
    fail(
      () => as(3, () => r.joinRoom({ invite: active.token!, personaId: personaIds[0]!, acceptedRulesVersion: 1 })),
      'INVALID_PERSONA',
      400,
    )
    const token = 'a'.repeat(64)
    systemDatabase()
      .insert(sessions)
      .values({ tokenHash: hashToken(token), userId: 'owner', renewedAt: Date.now(), expiresAt: Date.now() + 3600000 })
      .run()
    const server = createServer()
    const response = await server.request(`/api/rooms/${room.id}/invites`, {
      method: 'POST',
      headers: { Cookie: `nobot_session=${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'direct' }),
    })
    expect(response.status).toBe(400)
    const list = await (
      await server.request(`/api/rooms/${room.id}/invites`, { headers: { Cookie: `nobot_session=${token}` } })
    ).json()
    expect(list.find((i: { id: string }) => i.id === invite.id).status).toBe('used_up')
  })
  test('BUG-10 / BUG-14 / duplicate：预约过去、导出突发、重复开房', () => {
    const room = fixture()
    fail(
      () =>
        as(0, () =>
          ext.saveSession(room.id, { title: 'past', startsAt: Date.now() - 3600000, durationMinutes: 30, note: '' }),
        ),
      'SESSION_IN_PAST',
      400,
    )
    for (let i = 0; i < 3; i++) expect(() => as(1, () => ext.exportRoom(room.id, 'json'))).not.toThrow()
    fail(() => as(1, () => ext.exportRoom(room.id, 'markdown')), 'RATE_LIMITED', 429)
    fail(
      () => as(0, () => r.createRoom(shared.createRoomInput.parse({ chatId: room.chatId, name: 'again' }))),
      'ROOM_ALREADY_EXISTS',
      409,
    )
  })
  test('BUG-15 / typing / removal：私人额度信号、输入清除、踢出原因', async () => {
    const room = fixture()
    const events: { type: string; data: unknown }[] = []
    const registration = liveHub.register(
      'player',
      (e) => events.push(e),
      () => {},
    )
    await registration.join(`room:${room.id}`, () => true)
    as(1, () => turns.typing(room.id))
    as(1, () =>
      turns.sendRoomMessage(
        room.id,
        shared.roomSendInput.parse({ text: 'sent', channel: 'ooc', clientMessageId: 'typing' }),
      ),
    )
    expect(events.filter((e) => e.type === 'room.typing').at(-1)?.data).toMatchObject({
      payload: { userId: 'player', expiresAt: 0 },
    })
    as(0, () => r.updateRoom(room.id, { guestQuota: { perHour: 0, perDay: 0 } }))
    fail(() => as(0, () => r.checkQuota(r.roomRow(room.id), 'player')), 'ROOM_QUOTA', 429)
    expect(events.find((e) => e.type === 'room.quota')?.data).toMatchObject({
      roomId: room.id,
      code: 'ROOM_QUOTA',
      resetAt: expect.any(Number),
    })
    as(0, () => r.removeMember(room.id, 'player', 'banned'))
    expect(events.find((e) => e.type === 'room.removed')?.data).toMatchObject({ roomId: room.id, reason: 'banned' })
    registration.dispose()
  })
  test('Security：所有响应加安全头，Telegram 可嵌入，HTTP 不加 HSTS', async () => {
    const server = createServer()
    for (const path of ['/api/health', '/missing', '/tg', '/api/miniapp/context', '/assets/index.js']) {
      const response = await server.request(`http://local${path}`)
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
      expect(response.headers.get('Content-Security-Policy')).toContain(
        path === '/tg' || path.startsWith('/assets/') || path.startsWith('/api/miniapp/')
          ? 'https://web.telegram.org'
          : "frame-ancestors 'self'",
      )
      expect(response.headers.get('Strict-Transport-Security')).toBeNull()
    }
    expect((await server.request('https://local/api/health')).headers.get('Strict-Transport-Security')).toBeTruthy()
    const previous = process.env.TRUST_PROXY
    try {
      process.env.TRUST_PROXY = '0'
      expect(
        (await server.request('http://local/api/health', { headers: { 'X-Forwarded-Proto': 'https' } })).headers.get(
          'Strict-Transport-Security',
        ),
      ).toBeNull()
      process.env.TRUST_PROXY = '1'
      expect(
        (await server.request('http://local/api/health', { headers: { 'X-Forwarded-Proto': 'https' } })).headers.get(
          'Strict-Transport-Security',
        ),
      ).toBeTruthy()
    } finally {
      if (previous === undefined) delete process.env.TRUST_PROXY
      else process.env.TRUST_PROXY = previous
    }
  })
  test('关闭房间、关闭联机和删除会话带明确原因', async () => {
    const room = fixture()
    const events: { type: string; data: unknown }[] = []
    const registration = liveHub.register(
      'player',
      (e) => events.push(e),
      () => {},
    )
    await registration.join(`room:${room.id}`, () => true)
    as(0, () => r.updateRoom(room.id, { status: 'archived' }))
    expect(events.find((e) => e.type === 'room.settings')?.data).toMatchObject({ payload: { reason: 'room_closed' } })
    as(0, () => r.deleteRoom(room.id))
    expect(events.find((e) => e.type === 'room.removed')?.data).toMatchObject({ reason: 'online_play_off' })
    registration.dispose()
    const another = fixture()
    const deleted: { type: string; data: unknown }[] = []
    const second = liveHub.register(
      'player',
      (e) => deleted.push(e),
      () => {},
    )
    await second.join(`room:${another.id}`, () => true)
    const { deleteChat } = await import('../src/services/chats')
    await as(0, () => deleteChat(another.chatId))
    expect(deleted.find((e) => e.type === 'room.removed')?.data).toMatchObject({ reason: 'room_closed' })
    second.dispose()
  })
  test('BUG-18：普通编辑与 scope 校验一致，拒绝超长和空白', async () => {
    const room = fixture()
    const { dispatchScope } = await import('../src/services/rooms/scope')
    const m = as(1, () =>
      turns.sendRoomMessage(
        room.id,
        shared.roomSendInput.parse({ text: 'before', channel: 'ooc', clientMessageId: 'validation' }),
      ),
    )
    for (const content of ['', '  ', 'x'.repeat(100001), 42]) {
      await expect(
        as(1, () =>
          dispatchScope(
            room.id,
            new Request(`http://local/messages/${m.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content }),
            }),
            `/messages/${m.id}`,
          ),
        ),
      ).rejects.toMatchObject({ status: 400, code: 'VALIDATION' })
    }
    const { messageRoutes } = await import('../src/routes/messages')
    const response = await as(0, () =>
      messageRoutes.request(`/${m.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'x'.repeat(100001) }),
      }),
    )
    expect(response.status).toBe(400)
  })
  test('邀请失效错误仅限成员与创建者，封禁提示只给本人', () => {
    const room = fixture()
    for (const [changes, code] of [
      [{ expiresAt: 0 }, 'INVITE_EXPIRED'],
      [{ uses: 1 }, 'INVITE_USED_UP'],
      [{ revokedAt: Date.now() }, 'INVITE_REVOKED'],
    ] as const) {
      const invite = as(0, () => r.createInvite(room.id, shared.roomInviteInput.parse({ kind: 'link', maxUses: 1 })))
      systemDatabase().update(roomInvites).set(changes).where(eq(roomInvites.id, invite.id)).run()
      fail(() => as(1, () => r.validInvite(invite.token!)), code, 410)
      fail(() => as(3, () => r.lobby(invite.token!)), 'NOT_FOUND', 404)
      expect(
        as(1, () => r.joinRoom({ invite: invite.token!, personaId: personaIds[1]!, acceptedRulesVersion: 1 })).id,
      ).toBe(room.id)
    }
    const invite = as(0, () => r.createInvite(room.id, shared.roomInviteInput.parse({ kind: 'link' })))
    as(0, () => r.removeMember(room.id, 'player', 'banned'))
    fail(
      () => as(1, () => r.joinRoom({ invite: invite.token!, personaId: personaIds[1]!, acceptedRulesVersion: 1 })),
      'ROOM_BANNED',
      403,
    )
    fail(() => as(3, () => r.lobby('unknown')), 'NOT_FOUND', 404)
  })
  test('投票错误码区分主持权限和不可改票', () => {
    const room = fixture()
    expect(as(0, () => r.updateRoom(room.id, { choiceMode: 'vote' })).permissions.canPickChoice).toBe(false)
    const id = as(0, () => {
      const id = newId()
      db.insert(messages)
        .values({
          id,
          chatId: room.chatId,
          role: 'assistant',
          content: 'choose',
          createdAt: Date.now(),
          meta: { stage: { choices: [{ text: 'A' }, { text: 'B' }] } },
        })
        .run()
      setSetting(`room.choice:${room.id}:${id}`, {
        messageId: id,
        votes: { player: 0 },
        picks: [],
        closed: false,
        winner: null,
        deadline: Date.now() + 60000,
        counts: [1, 0],
      })
      return id
    })
    fail(() => as(0, () => trpg.pickRoomChoice(room.id, id, 0)), 'CHOICE_PLAYERS_ONLY', 403)
    fail(() => as(1, () => trpg.pickRoomChoice(room.id, id, 1)), 'VOTE_CHANGE_NOT_ALLOWED', 409)
    as(0, () => r.updateRoom(room.id, { choiceMode: 'gm' }))
    fail(() => as(1, () => trpg.pickRoomChoice(room.id, id, 1)), 'CHOICE_GM_ONLY', 403)
  })
  test('Security：房间和人设输入去除双向控制符，正文保留', async () => {
    const { createPersona } = await import('../src/services/personas')
    expect(as(1, () => createPersona(shared.personaInput.parse({ name: 'P\u202eQ' }))).name).toBe('PQ')
    const room = fixture()
    const detail = as(0, () => r.updateRoom(room.id, { name: 'A\u202eB', description: 'C\u2066D' }))
    expect(detail.name).toBe('AB')
    expect(detail.description).toBe('CD')
    expect(
      as(1, () => r.updatePersona(room.id, { name: 'P\u202eQ' })).members.find((m) => m.userId === 'player')!
        .personaName,
    ).toBe('PQ')
  })
}
