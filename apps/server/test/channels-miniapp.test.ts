import { expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('CH2b：Mini App 验签、作用域路由、权限、菜单和受管机器人完整链路', async () => {
  if (!process.env.CH2B_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, CH2B_TEST_CHILD: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'nobot-ch2b-'))
  process.env.DATA_DIR = directory
  const { channelAccountInput, createRoomInput } = await import('@nobot/shared')
  const { eq } = await import('drizzle-orm')
  const { db, setSetting } = await import('../src/db/client')
  const { systemDatabase } = await import('../src/db/system-client')
  const { users, sessions, roomMembers, notifications } = await import('../src/db/system-schema')
  const { channelAccounts, channelActors, channelMiniAppTokens } = await import('../src/db/schema')
  const { runAsUser, closeUserDatabase } = await import('../src/user-context')
  const { createServer } = await import('../src/server')
  const { createExtensionHost } = await import('../src/extensions/host')
  const registry = await import('../src/extensions/registry')
  const { channelService } = await import('../src/extensions/builtin/channels')
  const { createCharacter } = await import('../src/services/characters')
  const { createChat } = await import('../src/services/chats')
  const { createRoom } = await import('../src/services/rooms')
  const { ensureExternalUser } = await import('../src/services/external-users')
  const { hashToken } = await import('../src/services/auth')
  const { miniAppCookie, scopedRouteAllowed } = await import('../src/services/scoped-session')
  const { miniAppToken, miniAppButton, verifyInitData } = await import('../src/extensions/builtin/channels/miniapp')
  const { accountRow, accountDTO, listBindings } = await import('../src/extensions/builtin/channels/store')
  const { managedUsername } = await import('../src/extensions/builtin/channels/managed-bots')
  const owner = { id: 'ch2b-owner', handle: 'ch2b-owner', name: '主人', isAdmin: true }
  systemDatabase()
    .insert(users)
    .values({ ...owner, passwordHash: 'unused', createdAt: Date.now() })
    .run()
  const run = <T>(fn: () => T) => runAsUser(owner, fn)
  const normalToken = 'a'.repeat(64)
  systemDatabase()
    .insert(sessions)
    .values({
      userId: owner.id,
      tokenHash: hashToken(normalToken),
      renewedAt: Date.now(),
      expiresAt: Date.now() + 86400000,
    })
    .run()
  const normal = `nobot_session=${normalToken}`
  const server = createServer()
  const request = (path: string, method = 'GET', body?: unknown, cookie = normal) =>
    server.request(`https://local${path}`, {
      method,
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const signed = (token: string, data: Record<string, string> = {}) => {
    const fields = new URLSearchParams({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: 42 }),
      ...data,
    })
    const secret = createHmac('sha256', 'WebAppData').update(token).digest()
    fields.sort()
    fields.set(
      'hash',
      createHmac('sha256', secret)
        .update([...fields].map(([k, v]) => `${k}=${v}`).join('\n'))
        .digest('hex'),
    )
    return fields.toString()
  }
  const token = 'manager-secret'
  const valid = signed(token)
  expect(verifyInitData(valid, token, Date.now()).userId).toBe('42')
  for (const [data, key] of [
    [valid.replace('42', '43'), token],
    [valid, 'wrong'],
    [signed(token, { auth_date: '1' }), token],
    [signed(token, { auth_date: String(Math.floor(Date.now() / 1000) + 60) }), token],
    [`${valid}&user=x`, token],
    [signed(token, { user: '{' }), token],
  ])
    expect(() => verifyInitData(data!, key!, Date.now())).toThrow()
  for (const name of ['x', '角色', 'a'.repeat(100), 'a-b@bot', 'Bot'])
    expect(managedUsername(name)).toMatch(/^[a-zA-Z0-9_]{2,29}bot$/)
  const calls: { method: string; body: Record<string, unknown>; token: string }[] = []
  const host = createExtensionHost(registry.emitServerEvent)
  const service = run(() =>
    channelService({ host, settings: {}, storage: { get: () => undefined, set: () => {}, delete: () => {} } }),
  )
  service.runtime.fetch = async (input, init) => {
    const method = String(input).split('/').at(-1)!,
      botToken = String(input).split('/bot')[1]!.split('/')[0]!
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ method, body, token: botToken })
    if (method === 'getUpdates') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50)
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      })
      return Response.json({ ok: true, result: [] })
    }
    const result =
      method === 'getMe'
        ? {
            id: botToken === token ? 100 : 200,
            is_bot: true,
            username: botToken === token ? 'manager_bot' : 'child_bot',
            can_manage_bots: botToken === token,
          }
        : method === 'getManagedBotToken' || method === 'replaceManagedBotToken'
          ? 'child-secret'
          : method === 'getManagedBotAccessSettings'
            ? { is_access_restricted: true, added_user_ids: [42] }
            : method === 'sendMessage'
              ? { message_id: 1 }
              : true
    return Response.json({ ok: true, result })
  }
  try {
    const character = run(() => createCharacter({ name: '角色 A' }))
    run(() => {
      setSetting('extensionsEnabled', { channels: true })
      setSetting('ext:channels', { publicBaseUrl: 'https://local', miniAppMenuButton: true })
    })
    const account = await run(() =>
      service.runtime.create(
        channelAccountInput.parse({
          name: 'manager',
          credentials: { token },
          characterMode: 'fixed',
          characterId: character.id,
        }),
      ),
    )
    await run(() => service.runtime.start(account.id))
    expect(calls.find((c) => c.method === 'setChatMenuButton')?.body).toMatchObject({
      menu_button: { type: 'web_app', web_app: { url: expect.stringContaining('/tg?') } },
    })
    const chat = run(() => createChat({ characterId: character.id }))
    const binding = run(() =>
      service.saveBinding({
        id: 'dm-binding',
        accountId: account.id,
        scope: 'private',
        chat: '42',
        thread: '',
        actor: '',
        isolation: 'dm',
        source: 'new',
        chatId: chat.id,
        roomId: null,
        state: 'active',
        speakers: {},
        trigger: 'all',
        personaMode: null,
        settings: {},
        title: 'DM',
        lastActivityAt: Date.now(),
        createdBy: owner.id,
        idleWarnedAt: null,
      }),
    )
    void binding
    const actor = run(() =>
      db
        .insert(channelActors)
        .values({
          id: 'owner-actor',
          provider: 'telegram',
          externalId: '42',
          displayName: 'Owner',
          role: 'owner',
          linkedUserId: owner.id,
          accountIds: [account.id],
        })
        .returning()
        .get(),
    )
    const dm = run(() => listBindings(account.id)[0]!)
    expect(run(() => miniAppButton(dm))).toHaveProperty('web_app')
    const group = { ...dm, scope: 'group' as const }
    expect(run(() => miniAppButton(group))).toBeUndefined()
    run(() =>
      db
        .update(channelAccounts)
        .set({ botSnapshot: { ...accountRow(account.id).botSnapshot, has_main_web_app: true } })
        .where(eq(channelAccounts.id, account.id))
        .run(),
    )
    expect(run(() => miniAppButton(group))).toMatchObject({
      url: expect.stringContaining('https://t.me/manager_bot?startapp='),
    })
    const payload = run(() => miniAppToken(account.id, dm.id))
    const exchange = (initData: string, start = payload) =>
      request(`/hooks/channels/${owner.handle}/miniapp/session`, 'POST', { initData, start }, '')
    const session = await exchange(valid)
    expect(session.status, await session.clone().text()).toBe(200)
    const cookieHeader = session.headers.get('Set-Cookie')!
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=None', 'Partitioned', 'Max-Age=7200'])
      expect(cookieHeader).toContain(attribute)
    const cookie = cookieHeader.split(';')[0]!
    expect(cookie.startsWith(miniAppCookie)).toBe(true)
    expect((await exchange(valid)).status).toBe(403)
    expect((await exchange(signed(token, { query_id: 'unknown' }), 'missing')).status).toBe(403)
    expect((await exchange(signed(token, { user: JSON.stringify({ id: 999 }) }))).status).toBe(403)
    expect((await request(`/api/chats/${chat.id}`, 'GET', undefined, cookie)).status).toBe(200)
    expect((await request('/api/miniapp/context', 'GET', undefined, cookie)).status).toBe(200)
    expect((await request(`/api/miniapp/context?start=${payload}`, 'GET', undefined, cookie)).status).toBe(200)
    expect((await request('/api/miniapp/context?start=unknown', 'GET', undefined, cookie)).status).toBe(403)
    const menuToken = run(() => miniAppToken(account.id))
    const menuSession = await exchange(signed(token, { query_id: 'menu' }), menuToken)
    expect(menuSession.status).toBe(200)
    expect(((await menuSession.json()) as { chatId: string }).chatId).toBe(chat.id)
    run(() => db.update(channelActors).set({ role: 'blocked' }).where(eq(channelActors.id, actor.id)).run())
    expect((await exchange(signed(token, { query_id: 'blocked' }))).status).toBe(403)
    run(() => db.update(channelActors).set({ role: 'owner' }).where(eq(channelActors.id, actor.id)).run())
    expect((await request('/api/assets/attachments/unknown.webp', 'GET', undefined, cookie)).status).toBe(403)

    expect((await request('/api/auth/login', 'POST', {}, cookie)).status).toBe(403)
    expect((await request('/api/auth/password', 'POST', {}, cookie)).status).toBe(403)
    expect((await request('/api/settings', 'GET', undefined, `${cookie}; ${normal}`)).status).toBe(403)
    const otherChat = run(() => createChat({ characterId: character.id }))
    expect((await request(`/api/chats/${otherChat.id}`, 'GET', undefined, cookie)).status).toBe(403)
    const room = run(() => createRoom(createRoomInput.parse({ name: '房间', chatId: otherChat.id })))
    const external = run(() => ensureExternalUser('telegram', owner.id, '43', 'Guest'))
    run(() => {
      db.insert(channelActors)
        .values({
          id: 'external-actor',
          provider: 'telegram',
          externalId: '43',
          displayName: 'Guest',
          role: 'player',
          externalUserId: external.id,
          accountIds: [account.id],
        })
        .run()
      service.saveBinding({
        ...dm,
        id: 'room-binding',
        scope: 'group',
        chat: '-100',
        chatId: room.chatId,
        roomId: room.id,
      })
    })
    systemDatabase()
      .insert(roomMembers)
      .values({
        roomId: room.id,
        userId: external.id,
        role: 'spectator',
        state: 'active',
        personaName: 'Guest',
        personaDescription: '',
        acceptedRulesVersion: 1,
        joinedAt: Date.now(),
      })
      .run()
    const roomPayload = run(() => miniAppToken(account.id, 'room-binding'))
    const guestSession = await exchange(signed(token, { user: JSON.stringify({ id: 43 }) }), roomPayload)
    expect(guestSession.status, await guestSession.clone().text()).toBe(200)
    const guestCookie = guestSession.headers.get('Set-Cookie')!.split(';')[0]!
    expect(
      (await request(`/api/rooms/${room.id}/scope/chats/${room.chatId}`, 'GET', undefined, guestCookie)).status,
    ).toBe(200)
    expect((await request(`/api/rooms/${room.id}/messages`, 'POST', { text: 'no' }, guestCookie)).status).toBe(403)
    expect((await request(`/api/chats/${room.chatId}`, 'GET', undefined, guestCookie)).status).toBe(403)
    expect((await request(`/api/rooms/${room.id}/invites`, 'GET', undefined, guestCookie)).status).toBe(403)
    const ownerRoomSession = await exchange(signed(token, { query_id: 'owner-room' }), roomPayload)
    expect(ownerRoomSession.status).toBe(200)
    const ownerRoomCookie = ownerRoomSession.headers.get('Set-Cookie')!.split(';')[0]!
    expect((await request(`/api/rooms/${room.id}/invites`, 'POST', {}, ownerRoomCookie)).status).toBe(403)
    expect(
      (await request(`/api/rooms/${room.id}/scope/chats/${room.chatId}/vars`, 'POST', { set: {} }, ownerRoomCookie))
        .status,
    ).toBe(403)
    expect((await request(`/api/rooms/${room.id}/scope/chats/${chat.id}`, 'GET', undefined, guestCookie)).status).toBe(
      403,
    )

    // 从正式 Hono 路由表生成请求；新加路由默认拒绝，不能漏在手写列表之外。
    for (const scope of [
      { kind: 'chat' as const, chatId: chat.id },
      { kind: 'room' as const, roomId: room.id },
    ]) {
      const testCookie = scope.kind === 'chat' ? cookie : guestCookie
      let walked = 0
      for (const route of server.routes) {
        if (!route.path.startsWith('/api/')) continue
        const path = route.path
          .replaceAll('*', 'unknown')
          .replace(/:([^/]+)/g, (_, key: string) =>
            key === 'id' ? (scope.kind === 'chat' ? chat.id : room.id) : 'unknown',
          )
        for (const method of route.method === 'ALL' ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] : [route.method]) {
          if (scopedRouteAllowed(scope, method, path)) continue
          const response = await request(path, method, ['GET', 'HEAD'].includes(method) ? undefined : {}, testCookie)
          expect(response.status, `${method} ${path}`).toBe(403)
          walked++
        }
      }
      expect(walked).toBeGreaterThan(200)
    }
    run(() =>
      db.update(channelMiniAppTokens).set({ expiresAt: 0 }).where(eq(channelMiniAppTokens.token, payload)).run(),
    )
    expect((await exchange(signed(token, { query_id: 'expired' }))).status).toBe(403)
    await run(() =>
      service.receive(account.id, {
        update_id: 500,
        message: {
          message_id: 9,
          from: { id: 42, first_name: 'Owner' },
          chat: { id: 42, type: 'private' },
          text: '/vn',
        },
      }),
    )
    expect(calls.find((c) => c.method === 'sendMessage' && JSON.stringify(c.body).includes('web_app'))).toBeDefined()
    const link = await request(`/api/ext/channels/accounts/${account.id}/managed-bots/link`, 'POST', {
      characterId: character.id,
      suggestedUsername: '角-色 A',
    })
    expect(link.status, await link.clone().text()).toBe(200)
    expect(((await link.json()) as { url: string }).url).toContain('https://t.me/newbot/manager_bot/A_bot?name=')
    await run(() =>
      service.receive(account.id, {
        update_id: 501,
        managed_bot: { user: { id: 42 }, bot: { id: 200, is_bot: true, username: 'child_bot' } },
      }),
    )
    const child = run(() => db.select().from(channelAccounts).where(eq(channelAccounts.managedBy, account.id)).get())!
    expect(child).toBeDefined()
    expect(child.characterId).toBe(character.id)
    expect(child.presence.confirmed).toBe(true)
    expect(child.presence.avatar.mode).toBe('follow-character')
    expect(service.runtime.accounts.has(child.id)).toBe(true)
    expect(calls.find((c) => c.method === 'getManagedBotToken')?.body).toEqual({ user_id: 200 })
    expect(
      systemDatabase().select().from(notifications).where(eq(notifications.type, 'channel.managed-bot.created')).get(),
    ).toBeDefined()
    expect(
      (await request(`/api/ext/channels/accounts/${child.id}/managed-bots/link`, 'POST', { characterId: character.id }))
        .status,
    ).toBe(400)
    for (const [action, method, body] of [
      ['rotate-token', 'POST', undefined],
      ['access', 'GET', undefined],
      ['access', 'PUT', { restricted: true, addedUserIds: [42] }],
    ] as const)
      expect(
        (await request(`/api/ext/channels/accounts/${child.id}/managed-bots/${action}`, method, body)).status,
      ).toBe(200)
    expect(calls.find((c) => c.method === 'replaceManagedBotToken')?.body).toEqual({ user_id: 200 })
    expect(calls.find((c) => c.method === 'setManagedBotAccessSettings')?.body).toEqual({
      user_id: 200,
      is_access_restricted: true,
      added_user_ids: [42],
    })
    run(() => setSetting('ext:channels', {}))
    expect(run(() => accountDTO(accountRow(account.id)).miniApp)).toMatchObject({
      available: false,
      reason: expect.any(String),
    })
    expect(actor.role).toBe('owner')
  } finally {
    run(() => service.dispose())
    closeUserDatabase(owner.handle)
    closeUserDatabase('external-telegram')
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
