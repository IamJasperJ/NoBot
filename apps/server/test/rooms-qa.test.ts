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

  test('R4 BUG-36：清洗后的空消息和私信不能入库', () => {
    const room = fixture()
    for (const text of ['\u202e', ' \u2066\u2069 ']) {
      fail(
        () =>
          as(1, () =>
            turns.sendRoomMessage(room.id, shared.roomSendInput.parse({ text, channel: 'ooc', clientMessageId: text })),
          ),
        'VALIDATION',
        400,
      )
      fail(() => as(1, () => trpg.whisperRoom(room.id, { text, to: 'gm', clientMessageId: text })), 'VALIDATION', 400)
    }
    expect(as(0, () => ext.visibleHistory(room.id))).toHaveLength(0)
  })
  test('R4 BUG-36：渠道服务原有纯图片消息仍可发送，网页仍要求正文', async () => {
    const room = fixture()
    const sharp = (await import('sharp')).default
    const { dispatchScope } = await import('../src/services/rooms/scope')
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer()
    const form = new FormData()
    form.set('chatId', room.chatId)
    form.set('file', new File([new Uint8Array(bytes)], 'pixel.png', { type: 'image/png' }))
    const response = await as(1, () =>
      dispatchScope(room.id, new Request('http://room/attachments', { method: 'POST', body: form }), '/attachments'),
    )
    const attachment = (await response.json()) as { id: string }
    expect(
      shared.roomSendInput.safeParse({
        text: '',
        images: [attachment.id],
        channel: 'ooc',
        clientMessageId: 'web-image',
      }).success,
    ).toBe(false)
    const result = as(1, () =>
      turns.sendRoomMessage(room.id, {
        text: '',
        images: [attachment.id],
        channel: 'ooc',
        clientMessageId: 'channel-image',
      }),
    )
    expect(result.content).toBe('')
    expect(result.meta.images?.[0]?.id).toBe(attachment.id)
    await expect(
      as(1, () =>
        dispatchScope(
          room.id,
          new Request('http://room/messages', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: '\u202e' }),
          }),
          `/messages/${result.id}`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION', status: 400 })
  })
  test('R4 BUG-37：角色降级移除当前末项，升回玩家只追加一次', async () => {
    const room = fixture()
    as(0, () => r.updateRoom(room.id, { turnMode: 'initiative' }))
    as(0, () =>
      trpg.setInitiative(room.id, {
        order: [
          { kind: 'member', id: 'owner' },
          { kind: 'member', id: 'player' },
        ],
        current: 1,
      }),
    )
    const { roomRoutes } = await import('../src/routes/rooms')
    const role = (value: string) =>
      as(0, () =>
        roomRoutes.request(`/${room.id}/members/player/role`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: value }),
        }),
      )
    expect((await role('spectator')).status).toBe(200)
    expect(as(0, () => r.roomDetail(room.id)).initiative).toEqual({
      order: [{ kind: 'member', id: 'owner' }],
      current: 0,
    })
    expect(as(0, () => r.roomDetail(room.id)).round.round).toBe(2)
    expect((await role('gm')).status).toBe(200)
    expect(as(0, () => r.roomDetail(room.id)).initiative.order).toHaveLength(1)
    await role('spectator')
    await role('player')
    await role('player')
    expect(as(0, () => r.roomDetail(room.id)).initiative.order.at(-1)).toEqual({ kind: 'member', id: 'player' })
    expect(as(0, () => r.roomDetail(room.id)).initiative.order).toHaveLength(2)
  })
  test('R4 BUG-38：成员操作返回具体错误且外人仍不可探测', () => {
    const room = fixture()
    for (const [actor, input, code] of [
      [0, { kind: 'direct', targetUserId: 'owner' }, 'INVITE_SELF'],
      [0, { kind: 'direct', targetUserId: 'outsider' }, 'INVITE_NOT_FRIEND'],
      [2, { kind: 'link' }, 'INVITE_SPECTATOR_FORBIDDEN'],
      [1, { kind: 'link' }, 'INVITE_MEMBERS_DISABLED'],
      [1, { kind: 'link', role: 'spectator' }, 'INVITE_SPECTATOR_ROLE_FORBIDDEN'],
    ] as const)
      fail(() => as(actor, () => r.createInvite(room.id, shared.roomInviteInput.parse(input))), code, 403)
    for (const to of ['gm', 'owner'])
      fail(
        () => as(2, () => trpg.whisperRoom(room.id, { to, text: 'x', clientMessageId: to })),
        'WHISPER_SPECTATOR_SENDER',
        403,
      )
    for (const id of ['spectator', 'outsider'])
      fail(
        () => as(0, () => trpg.setInitiative(room.id, { order: [{ kind: 'member', id }], current: 0 })),
        'INITIATIVE_INVALID_MEMBER',
        400,
      )
    fail(() => as(0, () => trpg.setInitiative(room.id, { order: [], current: 1 })), 'INITIATIVE_INVALID_CURRENT', 400)
    fail(() => as(3, () => r.createInvite(room.id, shared.roomInviteInput.parse({ kind: 'link' }))), 'NOT_FOUND', 404)
  })
  test('R4 BUG-38：角色容量、禁旁观及邀请屏蔽双向一致', () => {
    const room = fixture()
    fail(() => as(0, () => r.changeMemberRole(room.id, 'owner', 'gm')), 'ROOM_OWNER_ROLE_FIXED', 403)
    as(0, () => r.updateRoom(room.id, { maxMembers: 2, maxSpectators: 1 }))
    fail(() => as(0, () => r.changeMemberRole(room.id, 'spectator', 'player')), 'ROOM_FULL', 409)
    fail(() => as(0, () => r.changeMemberRole(room.id, 'spectator', 'gm')), 'ROOM_FULL', 409)
    fail(() => as(0, () => r.changeMemberRole(room.id, 'player', 'spectator')), 'ROOM_SPECTATORS_FULL', 409)
    as(0, () => r.updateRoom(room.id, { allowSpectators: false }))
    fail(() => as(0, () => r.changeMemberRole(room.id, 'player', 'spectator')), 'ROOM_SPECTATORS_DISABLED', 403)
    fail(
      () => as(0, () => r.createInvite(room.id, shared.roomInviteInput.parse({ kind: 'link', role: 'spectator' }))),
      'ROOM_SPECTATORS_DISABLED',
      403,
    )
    for (const [from, to] of [
      ['owner', 'outsider'],
      ['outsider', 'owner'],
    ] as const) {
      social.blockUser(from, to)
      try {
        fail(
          () =>
            as(0, () =>
              r.createInvite(room.id, shared.roomInviteInput.parse({ kind: 'direct', targetUserId: 'outsider' })),
            ),
          'INVITE_TARGET_UNAVAILABLE',
          403,
        )
      } finally {
        social.unblockUser(from, to)
      }
    }
  })
  test('R4 BUG-38：先攻、投票、转让和角色撤回状态错误可读', () => {
    const room = fixture()
    fail(() => as(0, () => trpg.skipRound(room.id, 'spectator')), 'ROUND_SPECTATOR', 400)
    fail(() => as(0, () => trpg.closeChoice(room.id, 'missing')), 'CHOICE_NOT_VOTING', 409)
    const transfer = require('../src/services/rooms/transfer') as typeof import('../src/services/rooms/transfer')
    fail(() => as(0, () => transfer.transferOffer(room.id, 'spectator')), 'TRANSFER_INVALID_TARGET', 400)
    fail(() => as(1, () => transfer.acceptTransfer(room.id)), 'TRANSFER_OFFER_UNAVAILABLE', 409)
    fail(() => as(1, () => transfer.declineTransfer(room.id)), 'TRANSFER_OFFER_UNAVAILABLE', 409)
  })
  test('R4 BUG-38：正常界面的失效素材、发言者和编辑状态有具体错误', () => {
    const room = fixture()
    const input = shared.roomSendInput.parse({ text: 'x', channel: 'ooc', clientMessageId: 'asset' })
    fail(
      () => as(1, () => turns.sendRoomMessage(room.id, { ...input, images: ['missing'] })),
      'ROOM_ATTACHMENT_UNAVAILABLE',
      400,
    )
    fail(
      () => as(0, () => turns.triggerTurn(room.id, 'owner', true, { mode: 'trigger', speakerId: 'missing' })),
      'ROOM_SPEAKER_UNAVAILABLE',
      400,
    )
    fail(() => as(0, () => r.removeMember(room.id, 'owner', 'left')), 'ROOM_OWNER_REMOVAL_FORBIDDEN', 403)
    const own = as(1, () => turns.sendRoomMessage(room.id, { ...input, clientMessageId: 'edit' }))
    as(0, () => {
      const id = newId()
      db.insert(messages)
        .values({
          id,
          chatId: room.chatId,
          parentId: own.id,
          role: 'assistant',
          content: 'reply',
          createdAt: Date.now(),
        })
        .run()
      const { chats } = require('../src/db/schema') as typeof import('../src/db/schema')
      db.update(chats).set({ activeLeafId: id }).where(eq(chats.id, room.chatId)).run()
    })
    fail(() => as(1, () => turns.editRoomMessage(room.id, own.id, 'late')), 'ROOM_MESSAGE_EDIT_EXPIRED', 409)
    fail(() => as(1, () => turns.suggest(room.id, own.id)), 'ROOM_SUGGESTION_INVALID_MESSAGE', 400)
    fail(() => as(0, () => trpg.choiceSnapshot(room.id, own.id)), 'CHOICE_UNAVAILABLE', 400)
  })
  test('R4 BUG-38：角色撤回状态失败有具体错误', async () => {
    const room = fixture()
    const { withdrawCharacter } = await import('../src/services/rooms/characters')
    const copyId = as(0, () => {
      const id = newId()
      db.insert(characters)
        .values({
          id,
          name: 'copy',
          extensions: { room: { roomId: room.id, ownerUserId: 'owner' } },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .run()
      return id
    })
    fail(() => as(0, () => withdrawCharacter(room.id, copyId)), 'ROOM_CHARACTER_NOT_IN_GROUP', 409)
  })
  test('R4 BUG-37：角色变更先攻通知异常不回滚已保存状态', () => {
    const room = fixture()
    as(0, () => trpg.setInitiative(room.id, { order: [{ kind: 'member', id: 'player' }], current: 0 }))
    const remove = trpg.removeInitiativeMember
    const notification = spyOn(trpg, 'removeInitiativeMember').mockImplementation((room, userId) => {
      remove(room, userId)
      throw new Error('r4 notification failure')
    })
    try {
      const detail = as(0, () => r.changeMemberRole(room.id, 'player', 'spectator'))
      expect(r.members(room.id).find((m) => m.userId === 'player')?.role).toBe('spectator')
      expect(detail.initiative.order).toEqual([])
    } finally {
      notification.mockRestore()
    }
  })
  test('R4 BUG-39：常见校验错误不泄露内部类型、枚举和正则，中英文登录一致', async () => {
    const { validationMessage } = await import('../src/lib/validate')
    const { setAppSettings } = await import('../src/services/settings')
    const { requestLanguage } = await import('../src/i18n/request-language')
    const { z } = await import('zod')
    const { createServer } = await import('../src/server')
    const cases = [
      [
        z.object({ maxMembers: z.number().max(32) }),
        { maxMembers: 33 },
        '玩家人数上限不能大于 32',
        'Member limit must not exceed 32',
      ],
      [
        z.object({ maxMembers: z.number().min(2) }),
        { maxMembers: 1 },
        '玩家人数上限不能小于 2',
        'Member limit must be at least 2',
      ],
      [
        z.object({ channel: z.enum(['ic', 'ooc']) }),
        { channel: 'bad' },
        '频道的取值无效',
        'Channel has an invalid value',
      ],
      [
        z.object({ startsAt: z.number().int() }),
        { startsAt: 1.2 },
        '开始时间必须是整数',
        'Start time must be a whole number',
      ],
      [z.object({ role: z.string() }), { role: 1 }, '身份必须是文字', 'Role must be text'],
      [
        z.object({ name: z.string().refine(() => false, 'internal details') }),
        { name: 'x' },
        '名称无效',
        'Name is invalid',
      ],
      [z.strictObject({}), { secret: 1 }, '参数包含不支持的字段', 'Parameters contain unsupported fields'],
    ] as const
    for (const language of ['zh', 'en'] as const)
      await as(0, () =>
        requestLanguage.run(language, async () => {
          setAppSettings({ language })
          for (const [schema, input, zh, en] of cases)
            expect(validationMessage(schema.safeParse(input).error!.issues)).toBe(language === 'zh' ? zh : en)
          const response = await createServer().request('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept-Language': language },
            body: JSON.stringify({ handle: '!!!', password: 'x' }),
          })
          expect(response.status).toBe(400)
          expect((await response.json()).error.message).toBe(
            language === 'zh' ? '用户名格式不正确' : 'Username has an invalid format',
          )
        }),
      )
    as(0, () => setAppSettings({ language: 'zh' }))
  })
  test('R4 BUG-40：人设新增和 PATCH 限制名字和描述长度', () => {
    for (const schema of [shared.personaInput, shared.personaUpdateInput]) {
      expect(schema.safeParse({ name: 'x'.repeat(5000) }).success).toBe(false)
      expect(schema.safeParse({ name: 'ok', description: 'x'.repeat(8001) }).success).toBe(false)
      expect(schema.safeParse({ name: 'x'.repeat(100), description: 'x'.repeat(8000) }).success).toBe(true)
    }
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
      'INVITE_USED_UP',
      410,
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
  test('邀请失效错误告知令牌持有者，封禁提示只给本人', () => {
    const room = fixture()
    for (const [changes, code] of [
      [{ expiresAt: 0 }, 'INVITE_EXPIRED'],
      [{ uses: 1 }, 'INVITE_USED_UP'],
      [{ revokedAt: Date.now() }, 'INVITE_REVOKED'],
    ] as const) {
      const invite = as(0, () => r.createInvite(room.id, shared.roomInviteInput.parse({ kind: 'link', maxUses: 1 })))
      systemDatabase().update(roomInvites).set(changes).where(eq(roomInvites.id, invite.id)).run()
      fail(() => as(1, () => r.validInvite(invite.token!)), code, 410)
      fail(() => as(3, () => r.lobby(invite.token!)), code, 410)
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
  test('R3 BUG-23：删除或关闭慢速生成房间，回调异常隔离且释放锁', async () => {
    const generation = await import('../src/services/generation/generation')
    const { mockLlm } = await import('./helpers/mockLlm')
    const { createApiPreset } = await import('../src/services/connections')
    const model = mockLlm()
    const errors: unknown[] = []
    const onError = (error: unknown) => {
      errors.push(error)
    }
    process.on('unhandledRejection', onError)
    try {
      as(0, () => createApiPreset(shared.apiPresetInput.parse({ name: 'slow', baseUrl: model.url, model: 'mock-one' })))
      model.setScript(() => ({ text: 'slow stream for room deletion', delayMs: 20 }))
      for (const action of ['delete', 'archive', 'listener'] as const) {
        const room = fixture()
        as(0, () => turns.triggerTurn(room.id))
        const job = generation.getJob(room.chatId)!
        if (action === 'listener')
          as(0, () =>
            generation.subscribe(job, () => {
              throw new Error('broken subscriber')
            }),
          )
        if (action === 'listener')
          as(0, () =>
            generation.subscribe(job, async (event) => {
              if (event.type === 'complete') throw new Error('broken async subscriber')
            }),
          )
        await Bun.sleep(50)
        if (action === 'delete') as(0, () => r.deleteRoom(room.id))
        if (action === 'archive') as(0, () => r.updateRoom(room.id, { status: 'archived' }))
        if (action !== 'listener') expect(job.controller.signal.aborted).toBe(true)
        for (let i = 0; i < 300 && generation.isGenerating(room.chatId); i++) await Bun.sleep(5)
        expect(generation.isGenerating(room.chatId)).toBe(false)
      }
      expect(errors).toEqual([])
    } finally {
      process.off('unhandledRejection', onError)
      model.stop()
    }
  })
  test('R3 BUG-24：房主往返转让覆盖旧设置，源设置移走', () => {
    const transfer = require('../src/services/rooms/transfer') as typeof import('../src/services/rooms/transfer')
    const { createApiPreset } = require('../src/services/connections') as typeof import('../src/services/connections')
    for (const i of [0, 1])
      as(i, () =>
        createApiPreset(
          shared.apiPresetInput.parse({ name: 'transfer', baseUrl: 'http://mock/v1', model: 'mock-one' }),
        ),
      )
    const room = fixture()
    for (const [from, to] of [
      [0, 1],
      [1, 0],
      [0, 1],
    ]) {
      as(from!, () => setSetting(`room-activity:${room.id}`, { moved: to }))
      as(from!, () => transfer.transferOffer(room.id, people[to!]!.id))
      expect(as(to!, () => transfer.acceptTransfer(room.id)).hostUserId).toBe(people[to!]!.id)
      const { getSetting } = require('../src/db/client') as typeof import('../src/db/client')
      expect(as(from!, () => getSetting(`room-activity:${room.id}`))).toBeUndefined()
      expect(as(to!, () => getSetting(`room-activity:${room.id}`))).toEqual({ moved: to })
    }
  })
  test('R3 BUG-25/26：过去预约可改标题，时间有动态和静态上限', () => {
    const room = fixture()
    const session = as(0, () =>
      ext.saveSession(room.id, { title: 'old', startsAt: Date.now(), durationMinutes: 30, note: '' }),
    )
    const { roomSessions } = require('../src/db/system-schema') as typeof import('../src/db/system-schema')
    const startsAt = Date.now() - 3600000
    systemDatabase().update(roomSessions).set({ startsAt }).where(eq(roomSessions.id, session.id)).run()
    expect(as(0, () => ext.saveSession(room.id, { ...session, startsAt, title: 'edited' }, session.id)).title).toBe(
      'edited',
    )
    fail(
      () => as(0, () => ext.saveSession(room.id, { ...session, startsAt: startsAt - 1 }, session.id)),
      'SESSION_IN_PAST',
      400,
    )
    fail(
      () => as(0, () => ext.saveSession(room.id, { ...session, startsAt: Date.now() + 3 * 366 * 86400000 })),
      'SESSION_TOO_FAR',
      400,
    )
    expect(shared.roomSessionInput.safeParse({ ...session, startsAt: 9e15 }).success).toBe(false)
  })
  test('R3 BUG-27：纯控制符名字返回正常校验错误', async () => {
    const { createPersona, updatePersona } = await import('../src/services/personas')
    for (const fn of [
      () => createPersona({ name: '\u202e' }),
      () => updatePersona(personaIds[0]!, { name: '\u2066' }),
      () => r.updatePersona(fixture().id, { name: '\u202e' }),
      () => r.updateRoom(fixture().id, { name: '\u202e' }),
    ])
      fail(() => as(0, fn), 'VALIDATION', 400)
  })
  test('R3 BUG-29：空先攻允许发言，重入玩家追加末尾，主持可发言', () => {
    const room = fixture()
    as(0, () => r.updateRoom(room.id, { turnMode: 'initiative' }))
    expect(() => as(1, () => trpg.assertInitiative(r.roomRow(room.id), 'player'))).not.toThrow()
    as(0, () => trpg.setInitiative(room.id, { order: [{ kind: 'member', id: 'player' }], current: 0 }))
    expect(() => as(0, () => trpg.assertInitiative(r.roomRow(room.id), 'owner'))).not.toThrow()
    as(1, () => r.removeMember(room.id, 'player', 'left'))
    const invite = as(0, () => r.createInvite(room.id, shared.roomInviteInput.parse({ kind: 'link' })))
    as(1, () => r.joinRoom({ invite: invite.token!, personaId: personaIds[1]!, acceptedRulesVersion: 1 }))
    expect(as(0, () => r.roomDetail(room.id)).initiative.order.at(-1)).toEqual({ kind: 'member', id: 'player' })
  })
  test('R3 BUG-30/35：无权编辑和撤回不占额度，正文去控制符', () => {
    const room = fixture()
    const m = as(1, () =>
      turns.sendRoomMessage(
        room.id,
        shared.roomSendInput.parse({ text: 'A\u202eB\u2066עברית', channel: 'ooc', clientMessageId: 'bidi' }),
      ),
    )
    expect(m.content).toBe('ABעברית')
    const own = as(0, () =>
      turns.sendRoomMessage(
        room.id,
        shared.roomSendInput.parse({ text: 'owner', channel: 'ooc', clientMessageId: 'owner' }),
      ),
    )
    for (let i = 0; i < 35; i++)
      fail(() => as(1, () => turns.editRoomMessage(room.id, own.id, 'bad')), 'ROOM_REFUSED', 403)
    expect(as(1, () => turns.editRoomMessage(room.id, m.id, 'C\u202eD')).content).toBe('CD')
    for (let i = 0; i < 35; i++) expect(() => as(1, () => turns.editRoomMessage(room.id, m.id, null))).not.toThrow()
  })
  function choiceFixture() {
    const room = fixture()
    as(0, () => r.updateRoom(room.id, { choiceMode: 'vote' }))
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
      return id
    })
    return { room, id }
  }
  test('R3 BUG-31：投票、私信具体错误，导出带恢复时间', () => {
    const { room, id } = choiceFixture()
    fail(() => as(2, () => trpg.pickRoomChoice(room.id, id, 0)), 'CHOICE_SPECTATOR', 403)
    fail(() => as(1, () => trpg.pickRoomChoice(room.id, id, 9)), 'CHOICE_INDEX_INVALID', 400)
    fail(() => as(1, () => trpg.closeChoice(room.id, id)), 'CHOICE_CLOSE_FORBIDDEN', 403)
    fail(() => as(0, () => trpg.closeChoice(room.id, id, 9)), 'CHOICE_WINNER_INVALID', 400)
    for (const [actor, to, code] of [
      [1, 'owner', 'WHISPER_PLAYERS_FORBIDDEN'],
      [1, 'player', 'WHISPER_SELF'],
      [0, 'outsider', 'WHISPER_RECIPIENT_NOT_MEMBER'],
      [0, 'unknown', 'WHISPER_RECIPIENT_NOT_MEMBER'],
    ] as const)
      fail(() => as(actor, () => trpg.whisperRoom(room.id, { to, text: 'x', clientMessageId: to })), code, 400)
    for (let i = 0; i < 3; i++) as(1, () => ext.exportRoom(room.id, 'json'))
    expect(() => as(1, () => ext.exportRoom(room.id, 'json'))).toThrow()
    try {
      as(1, () => ext.exportRoom(room.id, 'json'))
    } catch (error) {
      expect(error).toMatchObject({ details: { retryAfter: expect.any(Number), resetAt: expect.any(Number) } })
    }
  })
  test('R3 BUG-32：旁观人数下限', () => {
    const room = fixture()
    fail(() => as(0, () => r.updateRoom(room.id, { maxSpectators: 0 })), 'ROOM_CAPACITY_TOO_SMALL', 400)
  })
  test('R3 BUG-33：无人投票关闭后不选选项，不启动生成', () => {
    const { room, id } = choiceFixture()
    expect(as(0, () => trpg.closeChoice(room.id, id))).toMatchObject({ closed: true, winner: null })
    expect(as(0, () => turns.turnState(room.id)).running).toBe(false)
    expect(as(0, () => ext.visibleHistory(room.id)).at(-1)?.content).toContain('无人投票')
  })

  test('R3 BUG-23：异步素材保存回调在房间删除后静默结束', async () => {
    const { reserveChatAsset } = await import('../src/services/rooms/usage')
    const room = fixture()
    const reservation = as(0, () => reserveChatAsset(room.chatId, 'image'))!
    as(0, () => r.deleteRoom(room.id))
    expect(() => as(0, () => reservation.saved())).not.toThrow()
    expect(as(0, () => db.select().from(roomEvents).where(eq(roomEvents.roomId, room.id)).all())).toEqual([])
  })
  test('R3 BUG-29：渠道加入先攻房间也追加次序且清洗显示名', async () => {
    const { addChannelMember } = await import('../src/extensions/builtin/channels/rooms')
    const room = fixture()
    as(0, () => r.updateRoom(room.id, { turnMode: 'initiative' }))
    as(0, () =>
      addChannelMember(room.id, {
        provider: 'telegram',
        externalId: 'r3',
        displayName: 'A\u202eB',
        linkedUserId: 'outsider',
        role: 'member',
      } as Parameters<typeof addChannelMember>[1]),
    )
    const detail = as(0, () => r.roomDetail(room.id))
    expect(detail.initiative.order.at(-1)).toEqual({ kind: 'member', id: 'outsider' })
    expect(detail.members.find((m) => m.userId === 'outsider')?.personaName).toBe('AB')
  })
  test('R3 BUG-30：单人编辑允许空内容、控制符和连续编辑，仍限制长度', async () => {
    const { messageRoutes } = await import('../src/routes/messages')
    const room = fixture()
    const m = as(0, () =>
      turns.sendRoomMessage(
        room.id,
        shared.roomSendInput.parse({ text: 'single', channel: 'ooc', clientMessageId: 'single' }),
      ),
    )
    as(0, () => r.deleteRoom(room.id))
    for (let i = 0; i < 35; i++) {
      const content = i % 2 ? '' : '\u202e'
      const response = await as(0, () =>
        messageRoutes.request(`/${m.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content }),
        }),
      )
      expect(response.status).toBe(200)
      expect((await response.json()).content).toBe(content)
    }
    const { rateLimitMessage } = await import('../src/services/rooms/input')
    const deleted = spyOn(Map.prototype, 'delete')
    try {
      rateLimitMessage('r3-prune-key', 1)
      rateLimitMessage('r3-next-key', 60002)
      expect(deleted).toHaveBeenCalledWith('r3-prune-key')
    } finally {
      deleted.mockRestore()
    }
  })
  test('R3 BUG-31：中英文校验、Zod异常边界、好友剩余时间和旁观满员', async () => {
    const { app } = await import('../src/app')
    const { requestLanguage } = await import('../src/i18n/request-language')
    const { z } = await import('zod')
    const { setAppSettings } = await import('../src/services/settings')
    app.get('/r3-zod-error', () => {
      z.object({ name: z.string().min(1) }).parse({ name: '' })
      return new Response()
    })
    for (const [language, expected] of [
      ['zh', '内容太长，最多 100000 字'],
      ['en', 'Content is too long (max 100000 characters)'],
    ] as const) {
      as(0, () => setAppSettings({ language }))
      const response = await as(0, () =>
        requestLanguage.run(language, () =>
          app.request('/api/messages/missing', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'x'.repeat(100001) }),
          }),
        ),
      )
      expect(response.status).toBe(400)
      expect((await response.json()).error.message).toBe(expected)
      const invalid = await as(0, () => requestLanguage.run(language, () => app.request('/api/r3-zod-error')))
      expect(invalid.status).toBe(400)
      expect((await invalid.json()).error).toEqual({
        code: 'VALIDATION',
        message: language === 'zh' ? '名称不能为空' : 'Name is required',
      })
    }
    const now = Date.now()
    social.requestFriend('owner', 'spectator', now)
    social.respondFriend('spectator', 'owner', 'reject', now)
    for (const [elapsed, zh, en] of [
      [0, '24 小时', '24 hours'],
      [86400000 - 180000, '3 分钟', '3 minutes'],
    ] as const) {
      for (const [language, expected] of [
        ['zh', zh],
        ['en', en],
      ] as const) {
        as(0, () => setAppSettings({ language }))
        const request = () => as(0, () => social.requestFriend('owner', 'spectator', now + elapsed))
        expect(request).toThrow()
        try {
          request()
        } catch (error) {
          if (language === 'zh') expect((error as Error).message).not.toContain(' 后')
          expect(error).toMatchObject({
            code: 'SOCIAL_COOLDOWN',
            message: expect.stringContaining(expected),
            details: { retryAfter: expect.any(Number) },
          })
        }
      }
    }
    as(0, () => setAppSettings({ language: 'zh' }))
    const room = fixture()
    as(0, () => r.updateRoom(room.id, { maxSpectators: 1 }))
    const invite = as(0, () =>
      r.createInvite(room.id, shared.roomInviteInput.parse({ kind: 'link', role: 'spectator' })),
    )
    fail(
      () => as(3, () => r.joinRoom({ invite: invite.token!, personaId: personaIds[3]!, acceptedRulesVersion: 1 })),
      'ROOM_SPECTATORS_FULL',
      409,
    )
  })
  test('R3 BUG-24：转让末尾失败时两端设置和目录共同回滚', async () => {
    const transfer = await import('../src/services/rooms/transfer')
    const { getSetting } = await import('../src/db/client')
    const room = fixture()
    const key = `room-activity:${room.id}`
    as(0, () => setSetting(key, { source: true }))
    as(1, () => setSetting(key, { stale: true }))
    as(0, () => transfer.transferOffer(room.id, 'player'))
    const sqlite = systemDatabase().$client
    sqlite.exec(
      `CREATE TEMP TRIGGER r3_transfer_failure BEFORE UPDATE ON rooms WHEN OLD.id = '${room.id}' BEGIN SELECT RAISE(ABORT, 'injected transfer failure'); END`,
    )
    try {
      expect(() => as(1, () => transfer.acceptTransfer(room.id))).toThrow('injected transfer failure')
      expect(r.roomRow(room.id).hostUserId).toBe('owner')
      expect(as(0, () => getSetting(key))).toEqual({ source: true })
      expect(as(1, () => getSetting(key))).toEqual({ stale: true })
    } finally {
      sqlite.exec('DROP TRIGGER r3_transfer_failure')
    }
  })
  test('R3 BUG-29：已在房间的玩家重新加入补齐先攻，主持插话不消耗玩家轮次', () => {
    const room = fixture()
    as(0, () => r.updateRoom(room.id, { turnMode: 'initiative' }))
    const invite = as(0, () => r.createInvite(room.id, shared.roomInviteInput.parse({ kind: 'link' })))
    for (let i = 0; i < 2; i++)
      as(1, () => r.joinRoom({ invite: invite.token!, personaId: personaIds[1]!, acceptedRulesVersion: 1 }))
    const before = as(0, () => r.roomDetail(room.id))
    expect(before.initiative.order).toEqual([{ kind: 'member', id: 'player' }])
    as(0, () =>
      turns.sendRoomMessage(
        room.id,
        shared.roomSendInput.parse({ text: 'GM announcement', channel: 'ic', clientMessageId: 'gm-announcement' }),
      ),
    )
    const after = as(0, () => r.roomDetail(room.id))
    expect(after.initiative).toEqual(before.initiative)
    expect(after.round.round).toBe(before.round.round)
  })
  test('R3 BUG-23：入口记录未捕获异常与拒绝后子进程继续运行', async () => {
    const entry = new URL('../src/server.ts', import.meta.url).href
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `await import(${JSON.stringify(entry)}); Promise.reject(new Error('r3 rejection')); setTimeout(() => { throw new Error('r3 exception') }, 5); setTimeout(() => console.log('r3 survived'), 40)`,
      ],
      {
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, out + err).toBe(0)
    expect(out).toContain('r3 survived')
    expect(err).toContain('r3 rejection')
    expect(err).toContain('r3 exception')
  })
}
