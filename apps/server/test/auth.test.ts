import { Database } from 'bun:sqlite'
import { expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CharacterDTO, CurrentUserDTO, ExtensionDTO, SpriteDTO, UserDTO } from '@nobot/shared'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import sharp from 'sharp'

for (const scenario of ['setup', 'migration', 'rollback', 'accounts', 'recovery']) {
  test(`多用户鉴权与隔离：${scenario}`, async () => {
    if (process.env.AUTH_TEST_SCENARIO !== scenario) {
      if (process.env.AUTH_TEST_SCENARIO) return
      const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
        env: { ...process.env, AUTH_TEST_SCENARIO: scenario },
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
    // 测试正式入口时关掉直接调用业务 API 的测试回退，验证生产行为。
    delete (globalThis as typeof globalThis & { __NOBOT_TEST_USER__?: string }).__NOBOT_TEST_USER__
    const directory = await mkdtemp(join(tmpdir(), 'nobot-auth-'))
    process.env.DATA_DIR = directory
    process.env.NOBOT_ADMIN_USERNAME = 'admin'
    delete process.env.NOBOT_ADMIN_PASSWORD
    delete process.env.NOBOT_ADMIN_RESET
    process.env.TRUST_PROXY = '1'
    const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#fff' } })
      .png()
      .toBuffer()
    const legacyId = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    if (['migration', 'setup', 'rollback'].includes(scenario)) {
      const old = new Database(join(directory, 'app.db'))
      migrate(drizzle(old), { migrationsFolder: join(import.meta.dir, '../drizzle') })
      old.query('INSERT INTO characters (id, name, created_at, updated_at) VALUES (?, ?, 1, 1)').run(legacyId, '旧角色')
      old.close()
      await Bun.write(join(directory, 'assets/avatars', `${legacyId}.png`), png)
    }
    const { bootstrap } = await import('../src/bootstrap')
    const { createServer } = await import('../src/server')
    const { systemDatabase } = await import('../src/db/system-client')
    const { sessions, users } = await import('../src/db/system-schema')
    const { db } = await import('../src/db/client')
    const { paths } = await import('../src/env')
    const { eq } = await import('drizzle-orm')
    const { closeUserDatabase, currentUser, runAsUser } = await import('../src/user-context')
    expect(() => db.select()).toThrow('没有当前用户上下文')
    expect(() => paths.avatars).toThrow('没有当前用户上下文')
    const server = createServer()
    let ip = 0
    const req = (path: string, method = 'GET', body?: unknown, cookie?: string, headers: Record<string, string> = {}) =>
      server.request(`http://local/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const json = async <T>(path: string, method = 'GET', body?: unknown, cookie?: string): Promise<T> => {
      const response = await req(path, method, body, cookie)
      expect(response.status, await response.clone().text()).toBe(200)
      return response.json() as Promise<T>
    }
    const signIn = async (handle = 'admin', password = 'password-admin') => {
      const response = await req('/auth/login', 'POST', { handle, password }, undefined, {
        'X-Forwarded-For': `10.0.0.${++ip}`,
      })
      expect(response.status, await response.clone().text()).toBe(200)
      const cookie = response.headers.get('Set-Cookie')!
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
      expect(cookie).toContain('Max-Age=2592000')
      expect(cookie).toContain('Path=/')
      return { cookie: cookie.split(';')[0]!, user: (await response.json()) as CurrentUserDTO }
    }
    const upload = (path: string, cookie: string) => {
      const data = new FormData()
      data.set(path.endsWith('/sprites') ? 'files' : 'file', new File([png], 'avatar.png'))
      if (path.endsWith('/sprites')) data.set('expression', 'neutral')
      return server.request(`http://local/api${path}`, { method: 'POST', headers: { Cookie: cookie }, body: data })
    }
    try {
      if (scenario !== 'setup') process.env.NOBOT_ADMIN_PASSWORD = 'password-admin'
      if (scenario === 'rollback') {
        await Bun.write(join(directory, 'users/admin/assets/keep.txt'), 'keep')
        await expect(bootstrap()).rejects.toThrow('旧数据迁移失败')
        expect(await Bun.file(join(directory, 'app.db')).exists()).toBe(true)
        expect(await Bun.file(join(directory, 'assets/avatars', `${legacyId}.png`)).exists()).toBe(true)
        expect(await Bun.file(join(directory, 'users/admin/app.db')).exists()).toBe(false)
        expect(systemDatabase().select().from(users).all()).toHaveLength(0)
        return
      }
      await bootstrap()
      if (scenario === 'setup') {
        const response = await req('/auth/login', 'POST', { handle: 'admin', password: 'anything' }, undefined, {
          'Accept-Language': 'en',
        })
        expect(response.status).toBe(503)
        expect(await response.json()).toMatchObject({ error: { code: 'SETUP_REQUIRED' } })
        expect(await Bun.file(join(directory, 'app.db')).exists()).toBe(true)
        expect(await Bun.file(join(directory, 'assets/avatars', `${legacyId}.png`)).exists()).toBe(true)
        expect(await Bun.file(join(directory, 'users/admin/app.db')).exists()).toBe(false)
        return
      }
      const a = await signIn()
      expect(a.user).toMatchObject({ handle: 'admin', name: 'admin', isAdmin: true })
      expect((await json<CurrentUserDTO>('/auth/me', 'GET', undefined, a.cookie)).id).toBe(a.user.id)
      const stored = systemDatabase().select().from(sessions).get()!
      expect(stored.tokenHash).not.toBe(a.cookie.split('=')[1])
      expect(stored.tokenHash).toHaveLength(64)
      expect(systemDatabase().select().from(users).get()!.passwordHash).toStartWith('$argon2id$')
      if (scenario === 'migration') {
        expect((await json<CharacterDTO[]>('/characters', 'GET', undefined, a.cookie)).map((row) => row.name)).toEqual([
          '旧角色',
        ])
        const avatar = await server.request(`http://local/api/assets/avatars/${legacyId}.png`, {
          headers: { Cookie: a.cookie },
        })
        expect(avatar.status).toBe(200)
        // 资源仍可长期缓存，但只允许浏览器私有缓存；普通接口不缓存
        expect(avatar.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable')
        expect(
          (await server.request('http://local/api/characters', { headers: { Cookie: a.cookie } })).headers.get(
            'Cache-Control',
          ),
        ).toBe('private, no-store')
        expect(await Bun.file(join(directory, 'app.db')).exists()).toBe(false)
        expect(await Bun.file(join(directory, 'users/admin/app.db')).exists()).toBe(true)
        return
      }
      if (scenario === 'recovery') {
        await bootstrap()
        expect((await req('/auth/me', 'GET', undefined, a.cookie)).status).toBe(200)
        process.env.NOBOT_ADMIN_RESET = '1'
        process.env.NOBOT_ADMIN_PASSWORD = 'recovered-password'
        systemDatabase().update(users).set({ disabled: true, isAdmin: false }).where(eq(users.id, a.user.id)).run()
        await bootstrap()
        expect((await req('/auth/me', 'GET', undefined, a.cookie)).status).toBe(401)
        expect((await signIn('admin', 'recovered-password')).user.isAdmin).toBe(true)
        return
      }
      for (const path of [
        '/characters',
        `/assets/avatars/${legacyId}.png`,
        '/ext/audio/test',
        '/app-settings',
        '/extensions/audio/client.js',
        '/auth/me',
        '/admin/users',
      ]) {
        const response = await req(path)
        expect(response.status, path).toBe(401)
        expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } })
      }
      expect((await req('/health')).status).toBe(200)
      expect((await req('/auth/logout', 'POST')).status).toBe(200)
      const enResponse = await req('/auth/me', 'GET', undefined, undefined, { 'Accept-Language': 'en' })
      expect(await enResponse.json()).toMatchObject({ error: { message: 'Please log in first' } })
      expect((await req('/auth/login', 'POST', { handle: 'admin', password: 'wrong' })).status).toBe(401)
      for (let i = 0; i < 5; i++)
        expect(
          (
            await req('/auth/login', 'POST', { handle: 'missing', password: 'wrong' }, undefined, {
              'X-Forwarded-For': '192.0.2.1',
            })
          ).status,
        ).toBe(401)
      expect(
        (
          await req('/auth/login', 'POST', { handle: 'missing', password: 'wrong' }, undefined, {
            'X-Forwarded-For': '192.0.2.2',
          })
        ).status,
      ).toBe(429)
      // 同一 IP 的阈值是 20 次：换不同用户名继续试，第 20 次之后锁定
      for (let i = 0; i < 15; i++)
        expect(
          (
            await req('/auth/login', 'POST', { handle: `another${i}`, password: 'wrong' }, undefined, {
              'X-Forwarded-For': '192.0.2.1',
            })
          ).status,
        ).toBe(401)
      expect(
        (
          await req('/auth/login', 'POST', { handle: 'another', password: 'wrong' }, undefined, {
            'X-Forwarded-For': '192.0.2.1',
          })
        ).status,
      ).toBe(429)
      expect((await req('/characters', 'POST', { name: '跨站' }, a.cookie, { Origin: 'http://evil' })).status).toBe(403)
      expect(
        (
          await req('/auth/login', 'POST', { handle: 'admin', password: 'password-admin' }, undefined, {
            Origin: 'null',
          })
        ).status,
      ).toBe(403)
      const secure = await req('/auth/login', 'POST', { handle: 'admin', password: 'password-admin' }, undefined, {
        'X-Forwarded-Proto': 'https',
      })
      expect(secure.headers.get('Set-Cookie')).toContain('Secure')
      const bDTO = await json<UserDTO>(
        '/admin/users',
        'POST',
        { handle: 'bob', name: 'Bob', password: 'password-bob' },
        a.cookie,
      )
      expect(
        (await req('/admin/users', 'POST', { handle: 'bob', name: 'Bob', password: 'password-bob' }, a.cookie)).status,
      ).toBe(409)
      const b = await signIn('bob', 'password-bob')
      expect((await req('/admin/users', 'GET', undefined, b.cookie)).status).toBe(403)
      for (const input of [{ disabled: true }, { isAdmin: false }])
        expect((await req(`/admin/users/${a.user.id}`, 'PATCH', input, a.cookie)).status).toBe(400)
      expect((await req(`/admin/users/${a.user.id}`, 'DELETE', undefined, a.cookie)).status).toBe(400)
      const made: {
        cookie: string
        user: CurrentUserDTO
        character: CharacterDTO
        urls: string[]
        ids: Map<string, string>
      }[] = []
      for (const actor of [a, b]) {
        const ids = new Map<string, string>()
        for (const [resource, body] of [
          ['characters', { name: actor.user.handle }],
          ['lorebooks', { name: actor.user.handle }],
          ['presets', { name: actor.user.handle, data: {} }],
          ['personas', { name: actor.user.handle }],
          ['play-presets', { name: actor.user.handle, data: {} }],
        ] as const) {
          const row = await json<{ id: string }>(`/${resource}`, 'POST', body, actor.cookie)
          ids.set(resource, row.id)
        }
        const avatarResponse = await upload(`/characters/${ids.get('characters')}/avatar`, actor.cookie)
        expect(avatarResponse.status).toBe(200)
        const character = (await avatarResponse.json()) as CharacterDTO
        const spriteResponse = await upload(`/characters/${character.id}/sprites`, actor.cookie)
        expect(spriteResponse.status).toBe(200)
        const sprite = ((await spriteResponse.json()) as { added: SpriteDTO[] }).added[0]!
        made.push({ ...actor, character, ids, urls: [character.avatarUrl!, sprite.url] })
      }
      for (const [index, own] of made.entries()) {
        const other = made[1 - index]!
        for (const [resource, id] of own.ids) {
          const list = await json<{ id: string }[]>(`/${resource}`, 'GET', undefined, own.cookie)
          expect(list.some((row) => row.id === id)).toBe(true)
          expect(list.some((row) => row.id === other.ids.get(resource))).toBe(false)
          // 人设只有 PATCH 单项入口，其余资源都有 GET。
          expect(
            (
              await req(
                `/${resource}/${other.ids.get(resource)}`,
                resource === 'personas' ? 'PATCH' : 'GET',
                resource === 'personas' ? { name: '越权' } : undefined,
                own.cookie,
              )
            ).status,
          ).toBe(404)
        }
        for (const url of other.urls)
          expect((await server.request(`http://local${url}`, { headers: { Cookie: own.cookie } })).status).toBe(404)
        for (const url of own.urls)
          expect((await server.request(`http://local${url}`, { headers: { Cookie: own.cookie } })).status).toBe(200)
      }
      await json('/app-settings', 'PUT', { language: 'en' }, b.cookie)
      expect(await json('/app-settings', 'GET', undefined, a.cookie)).toMatchObject({ language: 'zh' })
      expect(await json('/app-settings', 'GET', undefined, b.cookie)).toMatchObject({ language: 'en' })
      // 同 id 第三方扩展属于各自用户，加载、路由、storage、前端文件均隔离。
      for (const actor of [a, b]) {
        const root = join(directory, 'users', actor.user.handle, 'extensions', 'local')
        await mkdir(root, { recursive: true })
        await Bun.write(
          join(root, 'manifest.json'),
          JSON.stringify({
            id: 'local',
            name: 'Local',
            description: '',
            version: '1',
            server: 'server.ts',
            client: 'client.js',
          }),
        )
        await Bun.write(join(root, 'client.js'), `export default '${actor.user.handle}'`)
        await Bun.write(
          join(root, 'server.ts'),
          `export default { routes(app, ctx) { ctx.storage.set('owner', '${actor.user.handle}'); app.get('/owner', c => c.json({ owner: ctx.storage.get('owner') })) }, dispose() { return Bun.write(${JSON.stringify(join(directory, `${actor.user.handle}-disposed`))}, 'disposed') } }`,
        )
        await json('/extensions/reload', 'POST', undefined, actor.cookie)
        await json('/extensions/local', 'PATCH', { enabled: true, approvePermissions: true }, actor.cookie)
        expect(await json('/ext/local/owner', 'GET', undefined, actor.cookie)).toEqual({ owner: actor.user.handle })
        const client = await server.request('http://local/api/extensions/local/client.js', {
          headers: { Cookie: actor.cookie },
        })
        expect(await client.text()).toContain(actor.user.handle)
      }
      expect(
        (await json<ExtensionDTO[]>('/extensions', 'GET', undefined, a.cookie)).filter((row) => row.id === 'local'),
      ).toHaveLength(1)
      expect((await req('/ext/image-gen/matting/status', 'GET', undefined, b.cookie)).status).toBe(200)
      expect((await req('/ext/image-gen/matting/install', 'POST', {}, b.cookie)).status).toBe(403)
      expect((await req('/ext/image-gen/matting', 'DELETE', undefined, b.cookie)).status).toBe(403)
      // promise / timer 延续原上下文，两个用户并发时代理不会串库。
      await Promise.all(
        [a, b].map((actor) =>
          runAsUser(actor.user, async () => {
            await new Promise((resolve) => setTimeout(resolve, 1))
            expect(currentUser().handle).toBe(actor.user.handle)
            expect(paths.avatars).toContain(`/users/${actor.user.handle}/`)
          }),
        ),
      )
      // 同内容合成不能合并跨用户的在途任务；清理一个用户的缓存不影响另一个。
      const { synthesizeVoice, clearTtsCache, cacheEntries } = await import(
        '../src/extensions/builtin/audio/tts/service'
      )
      const { ttsEngines } = await import('../src/extensions/builtin/audio/tts/engines')
      const { audioSettings } = await import('../src/extensions/builtin/audio/tts/settings')
      const voiceMock = spyOn(ttsEngines.edge, 'synthesize').mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        return { bytes: new Uint8Array([1, 2, 3]), mime: 'audio/mpeg' }
      })
      try {
        await Promise.all(
          [a, b].map((actor) =>
            runAsUser(actor.user, () =>
              synthesizeVoice({ engine: 'edge', voice: 'test', speed: 1 }, 'same text', audioSettings.parse({})),
            ),
          ),
        )
        expect(voiceMock).toHaveBeenCalledTimes(2)
        await runAsUser(a.user, clearTtsCache)
        expect(await runAsUser(a.user, cacheEntries)).toHaveLength(0)
        expect(await runAsUser(b.user, cacheEntries)).toHaveLength(1)
      } finally {
        voiceMock.mockRestore()
      }
      const secondB = await signIn('bob', 'password-bob')
      expect(
        (await req('/auth/password', 'PUT', { oldPassword: 'wrong', newPassword: 'changed-password' }, b.cookie))
          .status,
      ).toBe(400)
      await json('/auth/password', 'PUT', { oldPassword: 'password-bob', newPassword: 'changed-password' }, b.cookie)
      expect((await req('/auth/me', 'GET', undefined, b.cookie)).status).toBe(200)
      expect((await req('/auth/me', 'GET', undefined, secondB.cookie)).status).toBe(401)
      await json(`/admin/users/${bDTO.id}`, 'PATCH', { password: 'reset-password' }, a.cookie)
      expect((await req('/auth/me', 'GET', undefined, b.cookie)).status).toBe(401)
      const resetB = await signIn('bob', 'reset-password')
      await json(`/admin/users/${bDTO.id}`, 'PATCH', { disabled: true }, a.cookie)
      expect((await req('/auth/me', 'GET', undefined, resetB.cookie)).status).toBe(401)
      expect((await req('/auth/login', 'POST', { handle: 'bob', password: 'reset-password' })).status).toBe(401)
      await json(`/admin/users/${bDTO.id}`, 'PATCH', { disabled: false }, a.cookie)
      const enabledB = await signIn('bob', 'reset-password')
      // 超过一天才写续期，同时向浏览器续 cookie。
      const { hashToken } = await import('../src/services/auth')
      const hash = hashToken(enabledB.cookie.split('=')[1]!)
      systemDatabase()
        .update(sessions)
        .set({ renewedAt: Date.now() - 86400001 })
        .where(eq(sessions.tokenHash, hash))
        .run()
      const renewed = await req('/auth/me', 'GET', undefined, enabledB.cookie)
      expect(renewed.headers.get('Set-Cookie')).toContain('nobot_session=')
      expect((await req('/auth/me', 'GET', undefined, enabledB.cookie)).headers.get('Set-Cookie')).toBeNull()
      systemDatabase()
        .update(sessions)
        .set({ expiresAt: Date.now() - 1 })
        .where(eq(sessions.tokenHash, hash))
        .run()
      expect((await req('/auth/me', 'GET', undefined, enabledB.cookie)).status).toBe(401)
      expect(systemDatabase().select().from(sessions).where(eq(sessions.tokenHash, hash)).get()).toBeUndefined()
      await json('/auth/logout', 'POST', undefined, enabledB.cookie)
      expect((await req('/auth/me', 'GET', undefined, enabledB.cookie)).status).toBe(401)
      let release!: () => void
      const retiredTask = runAsUser(b.user, async () => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        expect(() => paths.avatars).toThrow('当前用户数据库已关闭')
        expect(() => db.select()).toThrow('当前用户数据库已关闭')
      })
      await json(`/admin/users/${bDTO.id}`, 'DELETE', undefined, a.cookie)
      release()
      await retiredTask
      expect((await json<UserDTO[]>('/admin/users', 'GET', undefined, a.cookie)).map((row) => row.handle)).toEqual([
        'admin',
      ])
      expect((await readdir(join(directory, 'deleted-users'))).some((name) => name.startsWith('bob-'))).toBe(true)
      expect(await Bun.file(join(directory, 'bob-disposed')).exists()).toBe(true)
      expect(await Bun.file(join(directory, 'users/bob/app.db')).exists()).toBe(false)
      const logoutResponse = await req('/auth/logout', 'POST', undefined, a.cookie)
      expect(logoutResponse.headers.get('Set-Cookie')).toContain('Max-Age=0')
      expect((await req('/auth/me', 'GET', undefined, a.cookie)).status).toBe(401)
    } finally {
      closeUserDatabase('admin')
      closeUserDatabase('bob')
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)
}
