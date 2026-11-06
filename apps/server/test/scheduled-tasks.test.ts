import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('定时任务持久化、补跑、防重叠、忙时延迟、停用隔离和脱敏状态', async () => {
  if (!process.env.TASKS_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, TASKS_CHILD: '1' },
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
  const dir = await mkdtemp(join(tmpdir(), 'scheduled-tasks-'))
  process.env.DATA_DIR = dir
  await (await import('../src/bootstrap')).bootstrap()
  const tasks = await import('../src/extensions/tasks')
  const { setSetting } = await import('../src/db/client')
  const { currentUser, runAsUser, closeUserDatabase } = await import('../src/user-context')
  const { systemDatabase } = await import('../src/db/system-client')
  const { users } = await import('../src/db/system-schema')
  const user = currentUser()
  systemDatabase()
    .insert(users)
    .values({ ...user, passwordHash: 'unused', createdAt: 1 })
    .onConflictDoNothing()
    .run()
  let busy = false
  let calls = 0
  tasks.setTaskHost({
    trigger: () => {
      calls++
    },
    busy: () => busy,
    checkChat: (id) => {
      if (id !== 'chat') throw new Error('NOT_FOUND')
    },
  })
  const now = Date.now() + 3600000
  const action = { chatId: 'chat', instruction: 'Write in the same language as the conversation. Say hello.' }
  try {
    const once = tasks.createScheduledTask({ name: 'once', schedule: { kind: 'once', at: now }, action }, now - 1)
    await tasks.tickScheduledTasks(now)
    await tasks.tickScheduledTasks(now)
    expect(calls).toBe(1)
    expect(tasks.listScheduledTasks().find((t) => t.id === once.id)).toMatchObject({
      status: 'succeeded',
      nextRunAt: null,
      runCount: 1,
    })
    const skipped = tasks.createScheduledTask(
      { name: 'skip', schedule: { kind: 'once', at: now - 120000 }, action },
      now,
    )
    const catchup = tasks.createScheduledTask(
      { name: 'catchup', schedule: { kind: 'interval', everyMs: 10000, anchor: now }, misfire: 'once', action },
      now - 1,
    )
    await tasks.tickScheduledTasks(now + 120000)
    expect(calls).toBe(2)
    expect(tasks.listScheduledTasks().find((t) => t.id === skipped.id)?.status).toBe('skipped')
    expect(tasks.listScheduledTasks().find((t) => t.id === catchup.id)?.nextRunAt).toBe(now + 130000)
    tasks.setScheduledTaskEnabled(catchup.id, false)
    const delayed = tasks.createScheduledTask({ name: 'busy', schedule: { kind: 'once', at: now }, action }, now - 1)
    busy = true
    await tasks.tickScheduledTasks(now)
    expect(tasks.listScheduledTasks().find((t) => t.id === delayed.id)?.status).toBe('deferred')
    busy = false
    await tasks.tickScheduledTasks(now + 15000)
    expect(calls).toBe(3)
    // 用可控 Promise 保持首项执行，后项必须在首项结束前启动；下一轮也不得重复启动首项。
    const concurrent = new AbortController()
    let finishSlow!: () => void
    let slowRuns = 0
    let fastRuns = 0
    tasks
      .backgroundTasks('concurrent', concurrent.signal)
      .register({ id: 'slow', name: 'slow', schedule: { kind: 'once', at: now } }, () => {
        slowRuns++
        return new Promise<void>((resolve) => {
          finishSlow = resolve
        })
      })
    tasks
      .backgroundTasks('concurrent', concurrent.signal)
      .register({ id: 'fast', name: 'fast', schedule: { kind: 'once', at: now } }, () => {
        fastRuns++
      })
    const tick = tasks.tickScheduledTasks(now)
    try {
      expect(slowRuns).toBe(1)
      expect(fastRuns).toBe(1)
      await tasks.tickScheduledTasks(now + 1000)
      expect(slowRuns).toBe(1)
      expect(fastRuns).toBe(1)
      const current = tasks.listScheduledTasks().find((task) => task.id === 'concurrent:slow')!
      setSetting(`scheduled-task:${current.id}`, {
        ...current,
        name: 'changed',
        nextRunAt: now + 99999,
        enabled: false,
      })
    } finally {
      finishSlow()
      await tick
    }
    expect(tasks.listScheduledTasks().find((task) => task.id === 'concurrent:slow')).toMatchObject({
      name: 'changed',
      nextRunAt: now + 99999,
      enabled: false,
      status: 'succeeded',
      runCount: 1,
    })
    concurrent.abort()
    const controller = new AbortController()
    let release!: () => void
    tasks.backgroundTasks('plugin', controller.signal).register(
      { id: 'work', name: 'work', schedule: { kind: 'once', at: now } },
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const running = tasks.runScheduledTask('plugin:work', now)
    await expect(tasks.runScheduledTask('plugin:work', now)).rejects.toMatchObject({ code: 'TASK_RUNNING' })
    release()
    await running
    expect(tasks.listScheduledTasks().find((t) => t.id === 'plugin:work')?.runCount).toBe(1)
    tasks
      .backgroundTasks('plugin', controller.signal)
      .register({ id: 'fail', name: 'fail', schedule: { kind: 'once', at: now } }, () => {
        throw new TypeError('SECRET token')
      })
    await tasks.runScheduledTask('plugin:fail', now)
    expect(tasks.listScheduledTasks().find((t) => t.id === 'plugin:fail')).toMatchObject({
      status: 'failed',
      error: 'TypeError',
    })
    expect(JSON.stringify(tasks.listScheduledTasks())).not.toContain('SECRET')
    tasks
      .backgroundTasks('plugin', controller.signal)
      .register(
        { id: 'cancel', name: 'cancel', schedule: { kind: 'once', at: now } },
        (signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
      )
    const cancelled = tasks.runScheduledTask('plugin:cancel', now)
    tasks.setScheduledTaskEnabled('plugin:cancel', false)
    await cancelled
    expect(tasks.listScheduledTasks().find((task) => task.id === 'plugin:cancel')).toMatchObject({
      enabled: false,
      status: 'interrupted',
    })
    tasks
      .backgroundTasks('plugin', controller.signal)
      .register(
        { id: 'delete', name: 'delete', schedule: { kind: 'once', at: now } },
        (signal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
      )
    const deleted = tasks.runScheduledTask('plugin:delete', now)
    tasks.deleteScheduledTask('plugin:delete')
    await deleted
    expect(tasks.listScheduledTasks().some((task) => task.id === 'plugin:delete')).toBe(false)
    controller.abort()
    await expect(tasks.runScheduledTask('plugin:work', now)).rejects.toMatchObject({ code: 'TASK_INACTIVE' })
    const interrupted = { ...once, status: 'running', nextRunAt: null, runCount: 1 }
    setSetting(`scheduled-task:${once.id}`, interrupted)
    tasks.stopTaskScheduler(user.handle)
    tasks.startTaskScheduler()
    expect(tasks.listScheduledTasks().find((t) => t.id === once.id)?.status).toBe('interrupted')
    await tasks.tickScheduledTasks(now)
    expect(calls).toBe(3)
    const other = { id: 'task-other', handle: 'task-other', name: 'Other', isAdmin: false }
    systemDatabase()
      .insert(users)
      .values({ ...other, passwordHash: 'unused', createdAt: now })
      .run()
    await runAsUser(other, async () => {
      expect(tasks.listScheduledTasks()).toEqual([])
      expect(() => tasks.deleteScheduledTask(once.id)).toThrow()
    })
    closeUserDatabase(other.handle)
    tasks.deleteScheduledTask(once.id)
    expect(tasks.listScheduledTasks().some((t) => t.id === once.id)).toBe(false)
    // 接入真实路由和宿主，确认任务调用的是正常生成管线。
    const registry = await import('../src/extensions/registry')
    const { extensionRoutes } = await import('../src/routes/extensions')
    const { createCharacter } = await import('../src/services/characters')
    const { createChat, getChatRow, loadPath } = await import('../src/services/chats')
    const { createApiPreset } = await import('../src/services/connections')
    const { apiPresetInput } = await import('@nobot/shared')
    const { createExtensionHost } = await import('../src/extensions/host')
    const { mockLlm } = await import('./helpers/mockLlm')
    const host = createExtensionHost(registry.emitServerEvent)
    tasks.setTaskHost({
      trigger: ({ chatId, ...options }) => host.trigger(chatId, options),
      busy: (id) => host.isGenerating(id),
      checkChat: (id) => {
        host.getChatInfo(id, 0)
      },
    })
    const model = mockLlm()
    try {
      createApiPreset(apiPresetInput.parse({ name: 'Mock', baseUrl: model.url, model: 'mock-one' }))
      const character = createCharacter({ name: 'Alice' })
      const chat = createChat({ characterId: character.id })
      model.setScript(() => ({ text: 'Scheduled hello' }))
      const body = {
        name: 'HTTP',
        schedule: { kind: 'once', at: now },
        action: { chatId: chat.id, instruction: 'Say hello. Write in the same language as the conversation.' },
      }
      const created = await extensionRoutes.request('/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(created.status).toBe(201)
      const job = (await created.json()) as { id: string }
      const ran = await extensionRoutes.request(`/tasks/${job.id}/run`, { method: 'POST' })
      expect(ran.status).toBe(200)
      expect(await ran.json()).toMatchObject({ status: 'succeeded', runCount: 1 })
      await createExtensionHost(registry.emitServerEvent).waitIdle(chat.id, 5000)
      expect(
        loadPath(getChatRow(chat.id).activeLeafId, 10).some((message) => message.content === 'Scheduled hello'),
      ).toBe(true)
      const invalid = await extensionRoutes.request('/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, schedule: { kind: 'daily', time: '08:00', timeZone: 'invalid/timezone' } }),
      })
      expect(invalid.status).toBe(400)
    } finally {
      model.stop()
      await registry.unloadUserExtensions()
    }
  } finally {
    tasks.stopTaskScheduler(user.handle)
    await rm(dir, { recursive: true, force: true })
  }
})
