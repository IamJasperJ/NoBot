import { Database } from 'bun:sqlite'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CurrentUserDTO } from '@nobot/shared'
import { and, eq, like, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import * as schema from './db/schema'
import { seedUserDatabase } from './db/seed'
import { env } from './env'
import { t } from './i18n'
import { interruptMessageTasks } from './services/message-task-state'

export function userPaths(handle: string, dataDir = env.dataDir) {
  const root = join(dataDir, 'users', handle)
  return {
    db: join(root, 'app.db'),
    ttsCache: join(root, 'tts-cache'),
    sprites: join(root, 'assets/sprites'),
    avatars: join(root, 'assets/avatars'),
    audio: join(root, 'assets/audio'),
    backgrounds: join(root, 'assets/backgrounds'),
    attachments: join(root, 'assets/attachments'),
    extensions: join(root, 'extensions'),
  }
}
export type UserPaths = ReturnType<typeof userPaths>
export interface UserContext {
  user: CurrentUserDTO
  db: ReturnType<typeof drizzle<typeof schema>>
  sqlite: Database
  paths: UserPaths
}
const scope = new AsyncLocalStorage<UserContext>()
const connections = new Map<string, UserContext>()
const closedConnections = new WeakSet<Database>()
const testPaths = new Map<string, UserPaths>()
const testHandle = () => (globalThis as typeof globalThis & { __NOBOT_TEST_USER__?: string }).__NOBOT_TEST_USER__
const testDirectory = () => resolve(process.env.DATA_DIR ?? env.dataDir)

export function hasUserContext() {
  const ctx = scope.getStore()
  return ctx ? !closedConnections.has(ctx.sqlite) : !!testHandle()
}
function assertOpen(ctx: UserContext) {
  if (closedConnections.has(ctx.sqlite)) throw new Error(t('当前用户数据库已关闭'))
  return ctx
}

/** 数据库重新打开时旧进程的任务已不存在，结束等待并保留已保存的正文与素材。 */
function recoverInterruptedTasks(ctx: UserContext) {
  const { messages, settings } = schema
  const reason = () => t('服务重启前后台任务尚未完成')
  ctx.db.transaction((tx) => {
    tx.update(messages).set({ status: 'aborted' }).where(eq(messages.status, 'streaming')).run()
    const pending = tx
      .select({ id: messages.id, meta: messages.meta })
      .from(messages)
      .where(and(sql`json_valid(${messages.meta})`, like(messages.meta, '%"pending"%')))
      .all()
    for (const { id, meta } of pending) {
      const updated = interruptMessageTasks(meta, reason)
      if (updated !== meta) tx.update(messages).set({ meta: updated }).where(eq(messages.id, id)).run()
    }
    const actorSettings = tx
      .select()
      .from(settings)
      .where(
        and(like(settings.key, 'vn-actors:%'), sql`json_valid(${settings.value})`, like(settings.value, '%"pending"%')),
      )
      .all()
    for (const { key, value } of actorSettings) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const actors: Record<string, unknown> = { ...value }
      let changed = false
      for (const [actorKey, actor] of Object.entries(actors)) {
        if (!actor || typeof actor !== 'object' || !('status' in actor) || actor.status !== 'pending') continue
        actors[actorKey] = { ...actor, status: 'error', error: reason() }
        changed = true
      }
      if (changed) tx.update(settings).set({ value: actors }).where(eq(settings.key, key)).run()
    }
  })
}

function openUser(user: CurrentUserDTO, dataDir: string, paths = userPaths(user.handle, dataDir)) {
  const key = join(dataDir, user.handle)
  const cached = connections.get(key)
  if (cached) return { ...cached, user }
  for (const [name, path] of Object.entries(paths)) {
    mkdirSync(name === 'db' ? join(dataDir, 'users', user.handle) : path, { recursive: true })
  }
  const sqlite = new Database(paths.db, { create: true, strict: true })
  const ctx: UserContext = { user, sqlite, db: drizzle(sqlite, { schema }), paths }
  try {
    sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON')
    migrate(ctx.db, { migrationsFolder: env.migrationsDir })
    // 种子数据和翻译都必须看到新用户自己的数据库。
    scope.run(ctx, () => {
      recoverInterruptedTasks(ctx)
      seedUserDatabase()
    })
    connections.set(key, ctx)
    return ctx
  } catch (error) {
    sqlite.close()
    throw error
  }
}
export function currentContext(): UserContext {
  const ctx = scope.getStore()
  if (ctx) return assertOpen(ctx)
  const handle = testHandle()
  if (handle) {
    const dataDir = testDirectory()
    return openUser({ id: handle, handle, name: handle, isAdmin: true }, dataDir, currentPaths())
  }
  throw new Error(t('没有当前用户上下文'))
}
export function currentPaths(): UserPaths {
  const ctx = scope.getStore()
  if (ctx) return assertOpen(ctx).paths
  const handle = testHandle()
  if (!handle) throw new Error(t('没有当前用户上下文'))
  const dataDir = testDirectory()
  let paths = testPaths.get(dataDir)
  if (!paths) {
    paths = userPaths(handle, dataDir)
    testPaths.set(dataDir, paths)
    for (const [name, path] of Object.entries(paths))
      mkdirSync(name === 'db' ? join(dataDir, 'users', handle) : path, { recursive: true })
  }
  return paths
}
export const currentUser = () => currentContext().user
export function runAsUser<T>(user: CurrentUserDTO, fn: () => T): T {
  return scope.run(openUser(user, env.dataDir), fn)
}
const closeListeners = new Set<(handle: string) => void>()
/** 先同步中止后台任务，避免关闭连接后继续写库。 */
export function onUserDatabaseClose(listener: (handle: string) => void) {
  closeListeners.add(listener)
  return () => closeListeners.delete(listener)
}
export function closeUserDatabase(handle: string) {
  for (const listener of closeListeners) listener(handle)
  const key = join(env.dataDir, handle)
  const ctx = connections.get(key)
  if (ctx) {
    ctx.sqlite.close()
    // 已删除用户的后台 promise 仍可能继续，禁止它们重新写出用户目录。
    closedConnections.add(ctx.sqlite)
    connections.delete(key)
  }
}

/** 渠道成员只借用房主连接执行已有房间服务，不打开外部成员的私人库。 */
export function runAsRoomActor<T>(user: CurrentUserDTO, fn: () => T): T {
  return scope.run({ ...currentContext(), user }, fn)
}
