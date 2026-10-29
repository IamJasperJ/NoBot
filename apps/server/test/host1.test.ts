import { expect, spyOn, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 用户库、扩展模块和模拟模型均在子进程中隔离。
test('HOST1：第三方后台恢复、生命周期与一次性触发指令', async () => {
  if (!process.env.HOST1_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, HOST1_CHILD: '1', MOCK_LLM_FETCH: '1' },
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
  const directory = await mkdtemp(join(tmpdir(), 'nobot-host1-'))
  process.env.DATA_DIR = directory
  const shared = await import('@nobot/shared')
  const { eq } = await import('drizzle-orm')
  const { systemDatabase } = await import('../src/db/system-client')
  const sys = await import('../src/db/system-schema')
  const { db, setSetting } = await import('../src/db/client')
  const schema = await import('../src/db/schema')
  const { runAsUser, closeUserDatabase } = await import('../src/user-context')
  const registry = await import('../src/extensions/registry')
  const { detectPermissions, permissionFingerprint, isApproved } = await import('../src/extensions/permissions')
  const { createExtensionHost } = await import('../src/extensions/host')
  const { createCharacter } = await import('../src/services/characters')
  const { createChat, loadPath, getChatRow } = await import('../src/services/chats')
  const { createGroup } = await import('../src/services/groups')
  const { createApiPreset } = await import('../src/services/connections')
  const rooms = await import('../src/services/rooms')
  const { triggerTurn } = await import('../src/services/rooms/turns')
  const { dispatchScope } = await import('../src/services/rooms/scope')
  const { assemble, loadGenerationContext } = await import('../src/services/generation/context')
  const { quietPrompt } = await import('../src/services/generation/quiet-prompt')
  const { mockLlm } = await import('./helpers/mockLlm')
  const owner = { id: 'host1', handle: 'host1', name: 'Owner', isAdmin: true }
  const player = { id: 'player', handle: 'player', name: 'Player', isAdmin: false }
  const disabled = { id: 'disabled', handle: 'disabled', name: 'Disabled', isAdmin: false }
  for (const user of [owner, player, disabled])
    systemDatabase()
      .insert(sys.users)
      .values({ ...user, disabled: user === disabled, passwordHash: 'unused', createdAt: 1 })
      .run()
  const fixture = join(directory, 'users/host1/extensions/loop')
  await mkdir(fixture, { recursive: true })
  const source = (version: number) => `let saved; export default {
    id: 'loop', name: 'Loop', version: '${version}', defaultSettings: { value: 1 },
    startBackground(ctx, signal) {
      saved = ctx
      ctx.storage.set('starts', (ctx.storage.get('starts') ?? 0) + 1)
      ctx.storage.set('chats', ctx.host.listChats().length)
      signal.addEventListener('abort', () => {
        ctx.storage.set('aborts', (ctx.storage.get('aborts') ?? 0) + 1)
        ctx.storage.set('latest', ctx.settings.value)
      }, { once: true })
    },
    dispose() { saved?.storage.set('disposeAfterAbort', saved.storage.get('aborts') === saved.storage.get('starts')) },
    routes(app, ctx) { app.get('/state', c => c.json({ starts: ctx.storage.get('starts'), aborts: ctx.storage.get('aborts'), latest: ctx.storage.get('latest'), chats: ctx.storage.get('chats') })) }
  }`
  await Bun.write(join(fixture, 'index.ts'), source(1))
  const host = createExtensionHost(registry.emitServerEvent)
  const model = mockLlm()
  const index = () =>
    systemDatabase()
      .select()
      .from(sys.extensionBackgrounds)
      .where(eq(sys.extensionBackgrounds.userHandle, owner.handle))
      .all()
  // 统计语句入口，连冲突忽略的 INSERT 和未命中行的 DELETE 也能捕获。
  const inserts = spyOn(systemDatabase(), 'insert')
  const deletes = spyOn(systemDatabase(), 'delete')
  const indexWrites = () => ({
    inserts: inserts.mock.calls.filter(([table]) => table === sys.extensionBackgrounds).length,
    deletes: deletes.mock.calls.filter(([table]) => table === sys.extensionBackgrounds).length,
  })
  const expectStableIndex = async () => {
    const before = indexWrites()
    for (let i = 0; i < 3; i++) await registry.ensureUserExtensions()
    expect(indexWrites()).toEqual(before)
  }
  try {
    await runAsUser(owner, async () => {
      const defaults = shared.extensionPermissionsSchema.parse({})
      expect(defaults.background).toBe(false)
      const detected = detectPermissions({
        id: 'test',
        name: 'Test',
        description: '',
        version: '',
        startBackground() {},
      })
      expect(detected.background).toBe(true)
      expect(isApproved(permissionFingerprint(defaults, detected), permissionFingerprint(defaults, {}))).toBe(false)
      // 首次加载须读取已有索引，移除尚未批准的后台记录。
      systemDatabase().insert(sys.extensionBackgrounds).values({ userHandle: owner.handle, extensionId: 'loop' }).run()
      await registry.ensureUserExtensions()
      expect(registry.listExtensions().find((e) => e.id === 'loop')?.needsApproval).toBe(true)
      expect(index()).toHaveLength(0)
      expect(indexWrites()).toEqual({ inserts: 1, deletes: 1 })
      await expectStableIndex()
      const read = async () =>
        (await registry.forwardExtension('loop', new Request('http://local/api/ext/loop/state'))).json() as Promise<{
          starts: number
          aborts: number
          latest: number
          chats: number
        }>
      registry.updateExtension('loop', { enabled: true, approvePermissions: true })
      expect((await read()).starts).toBe(1)
      expect((await read()).chats).toBe(0)
      expect(index()).toHaveLength(1)
      expect(indexWrites()).toEqual({ inserts: 2, deletes: 1 })
      await expectStableIndex()
      expect((await read()).starts).toBe(1)
      const beforeSettings = indexWrites()
      registry.updateExtension('loop', { settings: { value: 9 } })
      expect(indexWrites()).toEqual(beforeSettings)
      registry.updateExtension('loop', { enabled: false })
      expect(index()).toHaveLength(0)
      expect(indexWrites()).toEqual({ inserts: 2, deletes: 2 })
      await expectStableIndex()
      registry.updateExtension('loop', { enabled: true })
      expect(indexWrites()).toEqual({ inserts: 3, deletes: 2 })
      await expectStableIndex()
      expect(await read()).toMatchObject({ starts: 2, aborts: 1, latest: 9 })
      // dispose 在后台中止之后执行；通过共享存储观察顺序。
      await Bun.write(join(fixture, 'index.ts'), source(2))
      await registry.reloadExtension('loop', fixture)
      // 每次重载只启动一次，旧版 dispose 读取到的中止计数与启动次数相同。
      await Bun.write(join(fixture, 'index.ts'), source(3))
      await registry.reloadExtension('loop', fixture)
      expect(await read()).toMatchObject({ starts: 4, aborts: 3 })
      await registry.unloadUserExtensions()
      expect(index()).toHaveLength(1)
    })
    // 冷启动只读系统索引，不经过 HTTP 请求。
    systemDatabase().insert(sys.extensionBackgrounds).values({ userHandle: disabled.handle, extensionId: 'loop' }).run()
    const beforeResume = indexWrites()
    await registry.resumeBackgrounds()
    expect(indexWrites()).toEqual(beforeResume)
    expect(existsSync(join(directory, 'users/disabled'))).toBe(false)
    const disabledFixture = join(directory, 'users/disabled/extensions/loop')
    await mkdir(disabledFixture, { recursive: true })
    await Bun.write(join(disabledFixture, 'index.ts'), source(1))
    await runAsUser(disabled, async () => {
      await registry.ensureUserExtensions()
      registry.updateExtension('loop', { enabled: true, approvePermissions: true })
      await expectStableIndex()
    })
    await runAsUser(owner, async () => {
      const { adminRoutes } = await import('../src/routes/admin')
      const response = await adminRoutes.request(`/users/${disabled.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disabled: true }),
      })
      expect(response.status).toBe(200)
      expect(
        systemDatabase()
          .select()
          .from(sys.extensionBackgrounds)
          .where(eq(sys.extensionBackgrounds.userHandle, disabled.handle))
          .all(),
      ).toHaveLength(0)
      const enable = await adminRoutes.request(`/users/${disabled.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disabled: false }),
      })
      expect(enable.status).toBe(200)
      const beforeEnable = indexWrites()
      await runAsUser(disabled, async () => {
        await registry.ensureUserExtensions()
        await expectStableIndex()
      })
      expect(indexWrites()).toEqual({ ...beforeEnable, inserts: beforeEnable.inserts + 1 })
      // 删除同样必须失效缓存，避免保留已不存在的用户索引状态。
      const stop = await adminRoutes.request(`/users/${disabled.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ disabled: true }),
      })
      expect(stop.status).toBe(200)
      systemDatabase()
        .insert(sys.extensionBackgrounds)
        .values({ userHandle: disabled.handle, extensionId: 'loop' })
        .run()
      const deletion = await adminRoutes.request(`/users/${disabled.id}`, { method: 'DELETE' })
      expect(deletion.status).toBe(200)
      expect(
        systemDatabase()
          .select()
          .from(sys.extensionBackgrounds)
          .where(eq(sys.extensionBackgrounds.userHandle, disabled.handle))
          .all(),
      ).toHaveLength(0)
      const state = await registry.forwardExtension('loop', new Request('http://local/api/ext/loop/state'))
      expect(await state.json()).toMatchObject({ starts: 5 })
      await registry.unloadExtension('loop')
      expect(index()).toHaveLength(0)
      const { getSetting } = await import('../src/db/client')
      expect(getSetting('extdata:loop:aborts')).toBe(5)
      expect(getSetting('extdata:loop:disposeAfterAbort')).toBe(true)
      // 新增后台权限导致旧批准失效，不启动新后台。
      setSetting('extensionsApproved', { loop: JSON.stringify(['server', 'routes']) })
      await registry.reloadExtension('loop', fixture)
      expect(registry.listExtensions().find((e) => e.id === 'loop')?.needsApproval).toBe(true)
      expect(index()).toHaveLength(0)
      expect(getSetting('extdata:loop:starts')).toBe(5)
      expect(permissionFingerprint(shared.extensionPermissionsSchema.parse({ background: true }), {})).toContain(
        'background',
      )
      await Bun.write(
        join(fixture, 'index.ts'),
        source(4).replace(
          "ctx.storage.set('starts',",
          "throw Object.assign(new Error('SECRET token'), { name: 'TypeError' }); ctx.storage.set('starts',",
        ),
      )
      await registry.reloadExtension('loop', fixture)
      registry.updateExtension('loop', { enabled: true, approvePermissions: true })
      expect(registry.listExtensions().find((e) => e.id === 'loop')?.backgroundError).toBe('TypeError')
      await registry.ensureUserExtensions()
      expect(getSetting('extdata:loop:starts')).toBe(5)
      expect(JSON.stringify(registry.listExtensions())).not.toContain('SECRET token')
      await Bun.write(
        join(fixture, 'index.ts'),
        source(4)
          .replace('startBackground(ctx, signal)', 'async startBackground(ctx, signal)')
          .replace("ctx.storage.set('starts',", "throw new RangeError('SECRET token'); ctx.storage.set('starts',"),
      )
      await registry.reloadExtension('loop', fixture)
      await Promise.resolve()
      expect(registry.listExtensions().find((e) => e.id === 'loop')?.backgroundError).toBe('RangeError')
      await registry.unloadExtension('loop')
      await Bun.write(join(fixture, 'index.ts'), source(5))
      await registry.reloadExtension('loop', fixture)
      registry.updateExtension('loop', { enabled: true, approvePermissions: true })
      expect(index()).toHaveLength(1)
      registry.updateExtension('loop', { approvePermissions: false })
      expect(index()).toHaveLength(0)
      await expectStableIndex()
      expect(getSetting('extdata:loop:aborts')).toBe(6)
      registry.updateExtension('loop', { approvePermissions: true })
      expect(index()).toHaveLength(1)
      await expectStableIndex()
      closeUserDatabase(owner.handle)
      await runAsUser(owner, async () => {
        expect(getSetting('extdata:loop:aborts')).toBe(7)
        await registry.ensureUserExtensions()
        expect(getSetting('extdata:loop:starts')).toBe(8)
        registry.updateExtension('loop', { enabled: false })
      })
    })
    await runAsUser(owner, async () => {
      createApiPreset(shared.apiPresetInput.parse({ name: 'Mock', baseUrl: model.url, model: 'mock-one' }))
      const actor = createCharacter({ name: 'Alice', fields: {} })
      const chat = createChat({ characterId: actor.id })
      model.setScript(() => ({ text: 'Hello', delayMs: 25 }))
      host.trigger(chat.id, { instruction: 'Secret {{char}} note' })
      expect(() => host.trigger(chat.id)).toThrow(expect.objectContaining({ status: 409, code: 'GENERATING' }))
      await host.waitIdle(chat.id, 5000)
      expect(
        model.requests
          .at(-1)
          ?.messages.filter((m) => m.role === 'system')
          .at(-1)?.content,
      ).toContain('Secret Alice note')
      expect(JSON.stringify(loadPath(getChatRow(chat.id).activeLeafId))).not.toContain('Secret')
      host.generate(chat.id, { mode: 'send', text: 'Next ordinary turn', images: [] })
      await host.waitIdle(chat.id, 5000)
      expect(JSON.stringify(model.requests.at(-1))).not.toContain('Secret')
      await quietPrompt({ chatId: chat.id, instruction: 'Say hello' })
      expect(JSON.stringify(model.requests.at(-1))).not.toContain('Secret')
      // 空白指令当作没有指令，不报校验错误
      host.trigger(chat.id, { instruction: '   ' })
      await host.waitIdle(chat.id, 5000)
      expect(JSON.stringify(model.requests.at(-1))).not.toContain('Trigger instruction')
      const other = createCharacter({ name: 'Bob', fields: {} })
      const group = createGroup({
        name: 'Team',
        activation: 'list',
        members: [{ characterId: actor.id }, { characterId: other.id }],
      })
      const groupChat = createChat({ groupId: group.id })
      const before = model.requests.length
      host.trigger(groupChat.id, { instruction: 'Group secret {{char}}' })
      await host.waitIdle(groupChat.id, 5000)
      expect(model.requests.slice(before)).toHaveLength(2)
      for (const request of model.requests.slice(before))
        expect(request.messages.filter((m) => m.role === 'system').at(-1)?.content).toContain('Group secret')
      expect(JSON.stringify(loadPath(getChatRow(groupChat.id).activeLeafId))).not.toContain('Group secret')
      const built = assemble(loadGenerationContext(chat.id, { requireConnection: true }), {
        type: 'normal',
        speakerId: actor.id,
        leafId: getChatRow(chat.id).activeLeafId,
        instruction: 'Build secret',
      })
      expect(built.input.injections?.find((i) => i.id === 'trigger-instruction')).toMatchObject({
        position: 'depth',
        depth: 0,
        role: 'system',
      })
      const roomChat = createChat({ characterId: actor.id })
      const room = rooms.createRoom(
        shared.createRoomInput.parse({ chatId: roomChat.id, name: 'Room', turnMode: 'host' }),
      )
      const events: unknown[] = []
      const off = rooms.subscribeRoomEvents((event) => {
        events.push(event)
      })
      try {
        host.trigger(roomChat.id, { instruction: 'Room secret' })
        expect(() => host.trigger(roomChat.id)).toThrow(expect.objectContaining({ code: 'GENERATING' }))
        await host.waitIdle(roomChat.id, 5000)
        expect(JSON.stringify(model.requests.at(-1))).toContain('Room secret')
        expect(db.select().from(schema.roomUsage).where(eq(schema.roomUsage.roomId, room.id)).all()).toHaveLength(1)
        expect(JSON.stringify(events)).toContain('room.generation')
        expect(JSON.stringify(events)).not.toContain('Room secret')
        await dispatchScope(
          room.id,
          new Request('http://local/generate', {
            method: 'POST',
            body: JSON.stringify({ mode: 'trigger', instruction: 'Owner HTTP secret' }),
          }),
          `/chats/${roomChat.id}/generate`,
        )
        await host.waitIdle(roomChat.id, 5000)
        expect(JSON.stringify(model.requests.at(-1))).toContain('Owner HTTP secret')
        expect(db.select().from(schema.roomUsage).where(eq(schema.roomUsage.roomId, room.id)).all()).toHaveLength(2)
        systemDatabase()
          .insert(sys.roomMembers)
          .values({
            roomId: room.id,
            userId: player.id,
            role: 'player',
            personaName: 'Player',
            personaDescription: '',
            acceptedRulesVersion: 1,
            joinedAt: 1,
          })
          .run()
        await runAsUser(player, async () => {
          await expect(
            dispatchScope(
              room.id,
              new Request('http://local/generate', {
                method: 'POST',
                body: JSON.stringify({ mode: 'trigger', instruction: 'Forbidden' }),
              }),
              `/chats/${roomChat.id}/generate`,
            ),
          ).rejects.toMatchObject({ status: 403 })
          expect(() => triggerTurn(room.id, player.id, false, { mode: 'trigger', instruction: 'Forbidden' })).toThrow(
            expect.objectContaining({ status: 403, code: 'TRIGGER_INSTRUCTION_FORBIDDEN' }),
          )
        })
        const { roomRoutes } = await import('../src/routes/rooms')
        const ownerTurn = await roomRoutes.request(`/${room.id}/turn`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ instruction: 'Direct room HTTP secret' }),
        })
        expect(ownerTurn.status).toBe(200)
        await host.waitIdle(roomChat.id, 5000)
        expect(JSON.stringify(model.requests.at(-1))).toContain('Direct room HTTP secret')
        systemDatabase().update(sys.roomMembers).set({ role: 'gm' }).where(eq(sys.roomMembers.userId, player.id)).run()
        await runAsUser(player, () =>
          dispatchScope(
            room.id,
            new Request('http://local/generate', {
              method: 'POST',
              body: JSON.stringify({ mode: 'trigger', instruction: 'GM HTTP secret' }),
            }),
            `/chats/${roomChat.id}/generate`,
          ),
        )
        await host.waitIdle(roomChat.id, 5000)
        expect(JSON.stringify(model.requests.at(-1))).toContain('GM HTTP secret')
        for (const status of ['paused', 'archived'] as const) {
          systemDatabase().update(sys.rooms).set({ status }).where(eq(sys.rooms.id, room.id)).run()
          expect(() => host.trigger(roomChat.id)).toThrow()
        }
      } finally {
        off()
      }
    })
  } finally {
    inserts.mockRestore()
    deletes.mockRestore()
    model.stop()
    await runAsUser(owner, registry.unloadUserExtensions)
    for (const user of [owner, player, disabled]) closeUserDatabase(user.handle)
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
