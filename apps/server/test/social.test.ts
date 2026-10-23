import { Database } from 'bun:sqlite'
import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LiveEnvelope } from '@nobot/shared'

// 独立进程隔离全局系统库与既有测试的用户上下文，避免改变其他测试的 DATA_DIR。
test('MP1 社交、在线状态、实时路由与跨库隔离', async () => {
  if (!process.env.MP1_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, MP1_TEST_CHILD: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'nobot-social-'))
  process.env.DATA_DIR = directory
  const { systemDatabase } = await import('../src/db/system-client')
  const { users, sessions, friendships, notifications, userBlocks, userPresencePrefs } = await import(
    '../src/db/system-schema'
  )
  const { eq } = await import('drizzle-orm')
  const { hashToken } = await import('../src/services/auth')
  const { createServer } = await import('../src/server')
  const { closeUserDatabase, runAsUser } = await import('../src/user-context')
  const social = await import('../src/services/social')
  const { PresenceService, presence } = await import('../src/services/social/presence')
  const { LiveHub, liveHub } = await import('../src/services/live/hub')
  const db = systemDatabase()
  const now = Date.now()
  const a = { id: 'a', handle: 'alice', name: 'Alice', isAdmin: true }
  const b = { id: 'b', handle: 'bob', name: 'Bob', isAdmin: false }
  for (const user of [a, b, { id: 'c', handle: 'carol', name: 'Carol', isAdmin: false }])
    db.insert(users)
      .values({ ...user, passwordHash: 'unused', createdAt: now })
      .run()
  const cookie = (id: string) => {
    const token = (id === 'a' ? 'a' : 'b').repeat(64)
    db.insert(sessions)
      .values({ tokenHash: hashToken(token), userId: id, renewedAt: now, expiresAt: now + 3600000 })
      .run()
    return `nobot_session=${token}`
  }
  const ac = cookie('a'),
    bc = cookie('b')
  const server = createServer()
  const request = (path: string, method = 'GET', body?: unknown, auth = ac) =>
    server.request(`http://local/api${path}`, {
      method,
      headers: { Cookie: auth, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const clear = () => {
    db.delete(friendships).run()
    db.delete(notifications).run()
    db.delete(userBlocks).run()
    db.delete(userPresencePrefs).run()
  }
  try {
    expect(social.findUserByHandle('ALICE', 'b')).toEqual({ id: 'a', handle: 'alice', name: 'Alice' })
    expect(social.findUserByHandle('ali', 'b')).toBeNull()
    db.update(users).set({ disabled: true }).where(eq(users.id, 'c')).run()
    expect(social.findUserByHandle('carol', 'a')).toBeNull()
    expect(() => social.requestFriend('a', 'alice', now)).toThrow()
    social.requestFriend('a', 'bob', now)
    expect(social.listFriends('a').outgoing).toHaveLength(1)
    expect(social.listFriends('b').incoming).toHaveLength(1)
    expect(social.unreadCount('b')).toBe(1)
    expect(() => social.respondFriend('a', 'b', 'accept', now)).toThrow()
    social.respondFriend('b', 'a', 'accept', now + 1)
    expect(social.listFriends('a').friends[0]?.id).toBe('b')
    expect(social.unreadCount('a')).toBe(1)
    expect(social.unreadCount('b')).toBe(0)
    social.removeFriend('b', 'a')
    expect(social.friendIds('a')).toEqual([])
    clear()
    social.requestFriend('a', 'bob', now + 2)
    social.requestFriend('b', 'alice', now + 3)
    expect(social.friendIds('a')).toEqual(['b'])
    clear()
    social.requestFriend('a', 'bob', now + 4)
    social.respondFriend('b', 'a', 'reject', now + 5)
    expect(social.listFriends('a').outgoing).toEqual([])
    expect(social.unreadCount('b')).toBe(0)
    expect(() => social.requestFriend('a', 'bob', now + 86400004)).toThrow()
    social.requestFriend('a', 'bob', now + 86400005)
    social.respondFriend('a', 'b', 'cancel', now + 86400006)
    expect(social.listFriends('b').incoming).toEqual([])
    expect(social.listNotifications('b').items).toEqual([])
    social.requestFriend('a', 'bob', now + 86400007)
    social.blockUser('b', 'a', now)
    expect(db.select().from(friendships).all()).toEqual([])
    expect(social.findUserByHandle('bob', 'a')).toBeNull()
    expect(() => social.requestFriend('a', 'bob', now + 86400008)).toThrow()
    expect(social.listBlocks('b')).toEqual([{ id: 'a', handle: 'alice', name: 'Alice' }])
    social.unblockUser('b', 'a')
    expect(social.findUserByHandle('bob', 'a')?.id).toBe('b')
    for (let i = 0; i < 20; i++) expect(() => social.requestFriend('c', 'missing', now)).toThrow()
    try {
      social.requestFriend('c', 'bob', now)
    } catch (error) {
      expect(error).toMatchObject({ status: 429 })
    }
    clear()
    const first = social.notify('a', 'room.invite', 'b')
    const second = social.notify('a', 'friend.accepted', 'b')
    expect(Number(second.id)).toBeGreaterThan(Number(first.id))
    expect(social.listNotifications('a', undefined, 1)).toMatchObject({
      items: [{ id: second.id }],
      nextCursor: second.id,
    })
    expect(social.listNotifications('a', second.id, 1).items[0]?.id).toBe(first.id)
    social.readNotifications('b', [first.id])
    expect(social.unreadCount('a')).toBe(2)
    social.readNotifications('a', [first.id])
    expect(social.unreadCount('a')).toBe(1)
    social.readNotifications('a')
    expect(social.unreadCount('a')).toBe(0)
    social.dismissNotification('a', second.id)
    expect(social.listNotifications('a').items).toHaveLength(1)
    clear()
    social.requestFriend('a', 'bob', now + 172800000)
    social.respondFriend('b', 'a', 'accept', now)
    let time = now
    const p = new PresenceService(() => time)
    const status = () => p.getPresence('a', ['b']).b?.status
    p.connect('b', 'tab1')
    expect(status()).toBe('online')
    time += 300000
    p.tick()
    expect(status()).toBe('away')
    p.activity('b')
    expect(status()).toBe('online')
    p.connect('b', 'tab2')
    p.disconnect('b', 'tab1')
    expect(status()).toBe('online')
    p.disconnect('b', 'tab2')
    time += 59999
    p.tick()
    expect(status()).toBe('online')
    p.connect('b', 'tab3')
    time += 2
    p.tick()
    expect(status()).toBe('online')
    p.setPreference('b', 'dnd')
    expect(status()).toBe('dnd')
    p.setPreference('b', 'invisible')
    expect(status()).toBe('offline')
    expect(p.getPresence('c', ['b'])).toEqual({})
    p.setPreference('b', 'auto')
    p.disconnect('b', 'tab3')
    time += 60000
    p.tick()
    expect(status()).toBe('offline')
    social.blockUser('a', 'b')
    expect(p.getPresence('a', ['b'])).toEqual({})
    social.unblockUser('a', 'b')
    const hub = new LiveHub(),
      received: LiveEnvelope[] = []
    let closed = 0
    const ca = hub.register(
      'a',
      (e) => received.push(e),
      () => closed++,
    )
    const cb = hub.register(
      'b',
      (e) => received.push(e),
      () => closed++,
    )
    expect(await ca.join('room:1', () => true)).toBe(true)
    expect(await cb.join('room:1', () => false)).toBe(false)
    expect(await ca.join('user:b', () => true)).toBe(false)
    const event = { type: 'test', topic: 'room:1', data: {} }
    hub.publishToUser('a', event)
    hub.publishToUsers(['a', 'a', 'b'], event)
    hub.publishToTopic('room:1', event, (id) => id === 'b')
    expect(received).toHaveLength(3)
    hub.publishToTopic('room:1', event)
    expect(received).toHaveLength(4)
    hub.disconnectUserFromTopic('a', 'room:1')
    hub.publishToTopic('room:1', event)
    expect(received).toHaveLength(4)
    hub.closeUser('a')
    expect(closed).toBe(1)
    ca.dispose()
    cb.dispose()
    expect((await request('/live', 'GET', undefined, '')).status).toBe(401)
    expect((await request('/live?since=bad')).status).toBe(400)
    expect((await request('/social/notifications/nope/dismiss', 'POST')).status).toBe(400)
    expect((await request('/social/users/lookup?handle=BoB')).status).toBe(200)
    expect((await request('/social/presence', 'PUT', { status: 'bad' })).status).toBe(400)
    clear()
    social.requestFriend('a', 'bob', now + 259200000)
    social.respondFriend('b', 'a', 'accept', now)
    presence.connect('b', 'snapshot-tab')
    const disconnected = spyOn(presence, 'disconnect')
    const notification = social.notify('a', 'friend.request', 'b')
    const later = social.notify('a', 'room.invite', 'b')
    const openLive = async (cursor?: string) => {
      const controller = new AbortController()
      const response = await server.request('http://local/api/live', {
        headers: { Cookie: ac, ...(cursor ? { 'Last-Event-ID': cursor } : {}) },
        signal: controller.signal,
      })
      expect(response.headers.get('Content-Type')).toContain('text/event-stream')
      return { controller, reader: response.body!.getReader() }
    }
    const intervals = spyOn(globalThis, 'setInterval')
    const stream = await openLive(notification.id)
    const heartbeat = intervals.mock.calls.find((call) => call[1] === 15000)?.[0]
    intervals.mockRestore()
    expect(heartbeat).toBeDefined()
    let buffer = ''
    while (!buffer.includes(`"id":"${later.id}"`)) {
      const chunk = await stream.reader.read()
      buffer += new TextDecoder().decode(chunk.value)
    }
    expect(buffer).toContain('retry: 3000')
    expect(buffer).toContain('event: hello')
    expect(buffer).toContain('event: notification')
    expect(buffer).toContain('"b":{"status":"online"}')
    expect(buffer).toContain('"unreadCount":3')
    for (let i = 0; i < 2; i++) {
      if (typeof heartbeat === 'function') heartbeat()
      let ping = ''
      while (!ping.includes('event: ping')) {
        ping += new TextDecoder().decode((await stream.reader.read()).value)
      }
      expect(ping).toContain('"type":"ping","topic":"user:a"')
      expect(ping).toMatch(/"serverTime":\d+/)
    }
    stream.controller.abort()
    await stream.reader.cancel()
    expect(disconnected).toHaveBeenCalled()
    disconnected.mockRestore()
    presence.disconnect('b', 'snapshot-tab')
    for (let i = 0; i < 201; i++) social.notify('a', 'room.invite', 'b')
    const overflow = await openLive(notification.id)
    buffer = ''
    while (!buffer.includes('event: resync')) {
      buffer += new TextDecoder().decode((await overflow.reader.read()).value)
    }
    overflow.controller.abort()
    await overflow.reader.cancel()
    let logoutClosed = false
    liveHub.register(
      'b',
      () => {},
      () => {
        logoutClosed = true
      },
    )
    expect((await request('/auth/logout', 'POST', undefined, bc)).status).toBe(200)
    expect(logoutClosed).toBe(true)
    // 实际建立两个用户库，系统关系表不应出现在任何一个私有库。
    for (const user of [a, b]) {
      runAsUser(user, () => {})
      const sqlite = new Database(join(directory, 'users', user.handle, 'app.db'), { readonly: true })
      expect(
        sqlite
          .query(
            "SELECT name FROM sqlite_master WHERE name IN ('friendships','notifications','user_blocks','user_presence_prefs')",
          )
          .all(),
      ).toEqual([])
      sqlite.close()
    }
    db.delete(users).where(eq(users.id, 'a')).run()
    expect(db.select().from(notifications).all()).toEqual([])
    presence.tick()
  } finally {
    liveHub.closeUser('a')
    liveHub.closeUser('b')
    closeUserDatabase('alice')
    closeUserDatabase('bob')
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
