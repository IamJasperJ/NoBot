import { createHash, randomBytes } from 'node:crypto'
import type { CurrentUserDTO, UserDTO } from '@nobot/shared'
import { and, eq, gt, lt, ne } from 'drizzle-orm'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { newId } from '../db/client'
import { systemDatabase } from '../db/system-client'
import { sessions, users } from '../db/system-schema'
import { HttpError } from '../errors'
import { t } from '../i18n'
import { liveHub } from './live/hub'
import { miniAppCookie, miniAppLifetime, writeMiniAppCookie } from './scoped-session'

type UserRow = typeof users.$inferSelect
export const sessionCookie = 'nobot_session'
const day = 24 * 60 * 60 * 1000
const lifetime = 30 * day
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
export const currentUserDTO = (user: UserRow): CurrentUserDTO => ({
  id: user.id,
  handle: user.handle,
  name: user.name,
  isAdmin: user.isAdmin,
})
export const userDTO = (user: UserRow): UserDTO => ({
  ...currentUserDTO(user),
  disabled: user.disabled,
  createdAt: user.createdAt,
  lastLoginAt: user.lastLoginAt,
})
export function unauthorized() {
  return new HttpError(401, 'UNAUTHORIZED', t('请先登录'))
}
export function requireAdmin(user: CurrentUserDTO) {
  if (!user.isAdmin) throw new HttpError(403, 'FORBIDDEN', t('只有管理员可以执行此操作'))
}
export function writeSessionCookie(c: Context, token: string, maxAge = lifetime / 1000) {
  setCookie(c, sessionCookie, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge,
    secure: new URL(c.req.url).protocol === 'https:' || c.req.header('X-Forwarded-Proto') === 'https',
  })
}
let lastCleanup = 0
export function authenticatedSession(c: Context, renew = true) {
  const scopedToken = getCookie(c, miniAppCookie)
  const token = scopedToken ?? getCookie(c, sessionCookie)
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw unauthorized()
  const db = systemDatabase()
  const now = Date.now()
  // 过期会话最多每小时清理一次：鉴权在每个请求（包括每张图片）上都会跑，不能次次写库。
  if (now - lastCleanup > 60 * 60 * 1000) {
    lastCleanup = now
    db.delete(sessions).where(lt(sessions.expiresAt, now)).run()
  }
  const row = db
    .select({ user: users, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, now)))
    .get()
  if (!row) {
    // 这个 token 的会话如果已过期，顺手删掉（全表清理是每小时一次）
    db.delete(sessions)
      .where(and(eq(sessions.tokenHash, hashToken(token)), lt(sessions.expiresAt, now)))
      .run()
    throw unauthorized()
  }
  if (row.user.disabled || (!row.session.scope && row.user.kind !== 'normal')) throw unauthorized()
  if (!!scopedToken !== !!row.session.scope) throw unauthorized()
  if (row.session.scope) {
    if (renew && now - row.session.renewedAt > 5 * 60 * 1000) {
      db.update(sessions)
        .set({ renewedAt: now, expiresAt: now + miniAppLifetime })
        .where(eq(sessions.tokenHash, row.session.tokenHash))
        .run()
      writeMiniAppCookie(c, token)
    }
    return row
  }
  if (now - row.session.renewedAt > day) {
    db.update(sessions)
      .set({ renewedAt: now, expiresAt: now + lifetime })
      .where(eq(sessions.tokenHash, row.session.tokenHash))
      .run()
    writeSessionCookie(c, token)
  }
  return row
}

interface Failures {
  count: number
  until: number
  touched: number
}
const handles = new Map<string, Failures>()
const ips = new Map<string, Failures>()
function checkLimit(map: Map<string, Failures>, key: string) {
  const now = Date.now()
  // 长时间没有失败的条目惰性清除，避免长期运行时积累无效 IP。
  for (const [id, value] of map) if (now - value.touched > day) map.delete(id)
  if ((map.get(key)?.until ?? 0) > now) throw new HttpError(429, 'RATE_LIMITED', t('登录失败次数过多，请稍后重试'))
}
/**
 * 记一次失败，连续 threshold 次后指数退避锁定（1 分钟起，最多 15 分钟）。
 * IP 的阈值放宽：没设 TRUST_PROXY 的反向代理后面所有人共用一个 IP，不能几次失败就把大家都锁在外面。
 */
function fail(map: Map<string, Failures>, key: string, threshold: number) {
  const count = (map.get(key)?.count ?? 0) + 1
  const now = Date.now()
  const until = count < threshold ? 0 : now + Math.min(15, 2 ** Math.min(count - threshold, 4)) * 60000
  map.set(key, { count, until, touched: now })
}
// 不存在的用户名也执行密码验证，避免用耗时区分账号是否存在。
let dummyHash: Promise<string> | undefined
export async function login(handle: string, password: string, ip: string) {
  const db = systemDatabase()
  if (!db.select({ id: users.id }).from(users).where(eq(users.kind, 'normal')).get())
    throw new HttpError(503, 'SETUP_REQUIRED', t('请设置 NOBOT_ADMIN_PASSWORD 并重启服务以创建管理员'))
  checkLimit(handles, handle)
  checkLimit(ips, ip)
  const user = db.select().from(users).where(eq(users.handle, handle)).get()
  dummyHash ??= Bun.password.hash(randomBytes(32).toString('hex'), { algorithm: 'argon2id' })
  const valid = await Bun.password.verify(
    password,
    (user?.kind === 'normal' ? user.passwordHash : null) ?? (await dummyHash),
  )
  // 验证密码期间可能被管理员禁用或重置密码，写会话前重新读取。
  const fresh = user && db.select().from(users).where(eq(users.id, user.id)).get()
  if (!valid || !fresh || fresh.kind !== 'normal' || fresh.disabled || fresh.passwordHash !== user?.passwordHash) {
    fail(handles, handle, 5)
    fail(ips, ip, 20)
    throw new HttpError(401, 'INVALID_CREDENTIALS', t('用户名或密码错误'))
  }
  handles.delete(handle)
  ips.delete(ip)
  const token = randomBytes(32).toString('hex')
  const now = Date.now()
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run()
  db.insert(sessions)
    .values({ tokenHash: hashToken(token), userId: fresh.id, renewedAt: now, expiresAt: now + lifetime })
    .run()
  db.update(users).set({ lastLoginAt: now }).where(eq(users.id, fresh.id)).run()
  return { token, user: currentUserDTO(fresh) }
}
export function logout(c: Context) {
  const token = getCookie(c, sessionCookie)
  const session = token
    ? systemDatabase()
        .select()
        .from(sessions)
        .where(eq(sessions.tokenHash, hashToken(token)))
        .get()
    : undefined
  if (session) liveHub.closeUser(session.userId)
  if (token)
    systemDatabase()
      .delete(sessions)
      .where(eq(sessions.tokenHash, hashToken(token)))
      .run()
  writeSessionCookie(c, '', 0)
}
export async function changePassword(userId: string, tokenHash: string, oldPassword: string, newPassword: string) {
  const db = systemDatabase()
  const user = db.select().from(users).where(eq(users.id, userId)).get()
  if (user?.kind !== 'normal' || !user.passwordHash || !(await Bun.password.verify(oldPassword, user.passwordHash)))
    throw new HttpError(400, 'INVALID_PASSWORD', t('旧密码错误'))
  const passwordHash = await Bun.password.hash(newPassword, { algorithm: 'argon2id' })
  db.transaction((tx) => {
    const fresh = tx.select().from(users).where(eq(users.id, userId)).get()
    const session = tx.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).get()
    if (fresh?.kind !== 'normal' || fresh.disabled || fresh.passwordHash !== user.passwordHash || !session)
      throw unauthorized()
    tx.update(users).set({ passwordHash }).where(eq(users.id, userId)).run()
    tx.delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, tokenHash)))
      .run()
  })
  liveHub.closeUser(userId)
}
export async function createUser(input: { handle: string; name: string; password: string; isAdmin: boolean }) {
  const passwordHash = await Bun.password.hash(input.password, { algorithm: 'argon2id' })
  const db = systemDatabase()
  if (db.select().from(users).where(eq(users.handle, input.handle)).get())
    throw new HttpError(409, 'HANDLE_EXISTS', t('用户名已存在'))
  const row = db
    .insert(users)
    .values({
      id: newId(),
      handle: input.handle,
      name: input.name,
      passwordHash,
      isAdmin: input.isAdmin,
      createdAt: Date.now(),
    })
    .returning()
    .get()
  return userDTO(row)
}
