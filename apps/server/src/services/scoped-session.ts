import { randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import { setCookie } from 'hono/cookie'
import { systemDatabase } from '../db/system-client'
import { sessions } from '../db/system-schema'
import { HttpError } from '../errors'
import { t } from '../i18n'
import { hashToken } from './auth'
import { getChatRow, loadMessage } from './chats'
import { membership } from './rooms'

export type SessionScope = NonNullable<typeof sessions.$inferSelect.scope>
export const miniAppCookie = 'nobot_miniapp_session'
export const miniAppLifetime = 2 * 60 * 60 * 1000
export function writeMiniAppCookie(c: Context, token: string) {
  // Telegram Web 的 iframe 需要跨站 cookie；CHIPS 将其限制在当前顶层站点分区。
  setCookie(c, miniAppCookie, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'None',
    partitioned: true,
    path: '/',
    maxAge: miniAppLifetime / 1000,
  })
}
export function mintScopedSession(c: Context, userId: string, scope: SessionScope) {
  const now = Date.now(),
    token = randomBytes(32).toString('hex')
  systemDatabase()
    .insert(sessions)
    .values({ tokenHash: hashToken(token), userId, scope, renewedAt: now, expiresAt: now + miniAppLifetime })
    .run()
  writeMiniAppCookie(c, token)
}
export function scopeDenied(): never {
  throw new HttpError(403, 'FORBIDDEN', t('此会话只能访问绑定的舞台'))
}
/** 默认拒绝；新增宿主路由不会自动获得 Mini App 权限。对象归属另在下方校验。 */
export function scopedRouteAllowed(scope: SessionScope, method: string, path: string) {
  if (path.includes('%') || path.includes('..') || path.includes('//')) return false
  if (method === 'GET' && ['/api/miniapp/context', '/api/miniapp/events'].includes(path)) return true
  if (scope.kind === 'room') {
    const base = `/api/rooms/${scope.roomId}`
    if (path.startsWith(`${base}/scope/`)) {
      const nested = path.slice(`${base}/scope/`.length)
      if (method === 'GET')
        return /^(chats\/[^/]+(?:\/stage)?|characters\/[^/]+(?:\/(sprites|cgs))?|assets\/.+)$/.test(nested)
      return method === 'POST' && /^chats\/[^/]+\/(generate|swipe|check|abort)$/.test(nested)
    }
    const tail = path.slice(base.length)
    if (!path.startsWith(`${base}/`) && path !== base) return false
    if (method === 'GET') return /^(|\/initiative|\/choices\/[^/]+)$/.test(tail)
    if (method === 'POST')
      return /^\/(messages|turn|turn\/request|abort|typing|roll|whispers|round\/ready|choices\/[^/]+\/vote|read)$/.test(
        tail,
      )
    return false
  }
  const base = `/api/chats/${scope.chatId}`
  if (method === 'GET')
    return (
      path === base ||
      path === `${base}/stage` ||
      path === `${base}/stream` ||
      /^\/api\/characters\/[^/]+(?:\/sprites)?$/.test(path) ||
      /^\/api\/assets\/(avatars|sprites|attachments|backgrounds|tts-cache)\//.test(path)
    )
  return method === 'POST' && ['generate', 'abort', 'swipe', 'check'].some((action) => path === `${base}/${action}`)
}
export async function enforceScope(c: Context, scope: SessionScope) {
  if (!scopedRouteAllowed(scope, c.req.method, c.req.path)) scopeDenied()
  if (scope.kind === 'room') {
    const { member, room } = membership(scope.roomId)
    if (member.role === 'spectator' && c.req.method !== 'GET') scopeDenied()
    // 房主也只能通过访客白名单玩游戏；变量和编辑等工具不属于本入口。
    const nested = c.req.path.split('/scope/')[1]
    const nestedChat = nested ? /^chats\/([^/]+)/.exec(nested) : null
    if (nestedChat && nestedChat[1] !== room.chatId) scopeDenied()
    if (
      nested &&
      !/^(chats\/[^/]+(?:\/(stage|generate|swipe|check|abort))?|characters\/[^/]+(?:\/(sprites|cgs))?|assets\/.+)$/.test(
        nested,
      )
    )
      scopeDenied()
    return
  }
  const chat = getChatRow(scope.chatId)
  const charMatch = /^\/api\/characters\/([^/]+)/.exec(c.req.path)
  if (charMatch && charMatch[1] !== chat.characterId) scopeDenied()
  if (c.req.path.startsWith('/api/assets/')) {
    // 资源下载必须来自当前舞台的结构化引用，不能接受正文里伪造的路径。
    const { chatAssetAllowed } = await import('./scoped-session-assets')
    if (!chatAssetAllowed(chat, c.req.path)) scopeDenied()
  }
  if (c.req.method === 'POST' && ['generate', 'swipe', 'check'].some((s) => c.req.path.endsWith(`/${s}`))) {
    const body: unknown = await c.req.raw
      .clone()
      .json()
      .catch(() => null)
    if (!body || typeof body !== 'object') scopeDenied()
    const record = body as Record<string, unknown>
    for (const key of ['targetId', 'messageId']) {
      const value = record[key]
      if (value !== undefined && (typeof value !== 'string' || loadMessage(value).chatId !== chat.id)) scopeDenied()
    }
    // 禁止借生成参数注入系统消息或使用别的角色。
    if ('role' in body && body.role !== 'user') scopeDenied()
    if ('speakerId' in body && body.speakerId !== chat.characterId) scopeDenied()
  }
}
