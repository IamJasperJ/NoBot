import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ChannelBindingDTO } from '@nobot/shared'
import { and, eq, gt, lt } from 'drizzle-orm'
import type { Context } from 'hono'
import { z } from 'zod'
import { db, getSetting } from '../../../db/client'
import { channelActors, channelMiniAppReplays, channelMiniAppTokens } from '../../../db/schema'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { mintScopedSession, type SessionScope, scopeDenied } from '../../../services/scoped-session'
import { currentUser } from '../../../user-context'
import { asChannelActor } from './rooms'
import { accountRow, bindingRow, channelLog, listBindings } from './store'

export function publicBaseUrl() {
  const settings = getSetting<Record<string, unknown>>('ext:channels')
  try {
    const url = new URL(String(settings?.publicBaseUrl ?? ''))
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      return null
    return url.origin
  } catch {
    return null
  }
}
export function miniAppToken(accountId: string, bindingId: string | null = null) {
  const now = Date.now()
  db.delete(channelMiniAppTokens).where(lt(channelMiniAppTokens.expiresAt, now)).run()
  const existing = db
    .select()
    .from(channelMiniAppTokens)
    .where(and(eq(channelMiniAppTokens.accountId, accountId), gt(channelMiniAppTokens.expiresAt, now + 3600000)))
    .all()
    .find((row) => row.bindingId === bindingId)
  if (existing) return existing.token
  const token = randomBytes(24).toString('base64url')
  db.insert(channelMiniAppTokens)
    .values({ token, accountId, bindingId, expiresAt: now + 86400000 })
    .run()
  return token
}
export function miniAppUrl(accountId: string, bindingId: string | null = null) {
  const base = publicBaseUrl()
  return base
    ? `${base}/tg?h=${encodeURIComponent(currentUser().handle)}&a=${miniAppToken(accountId, bindingId)}`
    : undefined
}
export type MiniAppButton = { text: string; web_app: { url: string } } | { text: string; url: string }
const omitted = new Set<string>()
export function miniAppButton(binding: ChannelBindingDTO): MiniAppButton | undefined {
  const url = miniAppUrl(binding.accountId, binding.id)
  if (!url) return
  if (binding.scope === 'private') return { text: '📖', web_app: { url } }
  const account = accountRow(binding.accountId)
  if (account.botSnapshot.has_main_web_app === true && account.botUsername)
    return { text: '📖', url: `https://t.me/${account.botUsername}?startapp=${miniAppToken(account.id, binding.id)}` }
  if (!omitted.has(account.id)) {
    omitted.add(account.id)
    channelLog({
      at: Date.now(),
      accountId: account.id,
      code: 'miniapp.main.required',
      message: t('群 VN 链接需要先在 BotFather 配置主 Mini App'),
    })
  }
}
const initUser = z.object({ id: z.number().int().safe() })
/** 不读取 initDataUnsafe；重复字段会造成签名与业务解释不一致，直接拒绝。 */
export function verifyInitData(input: string, token: string, now: number, maxAgeSeconds = 600) {
  const fields = new URLSearchParams(input)
  const keys = [...fields.keys()]
  if (new Set(keys).size !== keys.length) scopeDenied()
  const hash = fields.get('hash') ?? ''
  if (!/^[a-f0-9]{64}$/.test(hash)) scopeDenied()
  fields.delete('hash')
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  const check = [...fields]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  const expected = createHmac('sha256', secret).update(check).digest()
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) scopeDenied()
  const authDate = Number(fields.get('auth_date'))
  if (!Number.isSafeInteger(authDate) || authDate > now / 1000 || now / 1000 - authDate > maxAgeSeconds) scopeDenied()
  let user: unknown
  try {
    user = JSON.parse(fields.get('user') ?? 'null')
  } catch {
    scopeDenied()
  }
  const parsed = initUser.safeParse(user)
  if (!parsed.success) scopeDenied()
  return { fields, hash, userId: String(parsed.data.id), expiresAt: (authDate + maxAgeSeconds) * 1000 }
}
export function exchangeMiniApp(c: Context, input: { initData: string; start: string }) {
  if (!publicBaseUrl()) throw new HttpError(400, 'MINIAPP_UNAVAILABLE', t('请先设置 HTTPS 公网地址'))
  const payload = db.select().from(channelMiniAppTokens).where(eq(channelMiniAppTokens.token, input.start)).get()
  if (!payload || payload.expiresAt <= Date.now()) scopeDenied()
  const account = accountRow(payload.accountId)
  const settings = getSetting<Record<string, unknown>>('ext:channels')
  const maxAge = z.number().int().min(1).max(600).catch(600).parse(settings?.miniAppAuthMaxAgeSeconds)
  const verified = verifyInitData(input.initData, account.config.credentials.token, Date.now(), maxAge)
  const actor = db
    .select()
    .from(channelActors)
    .where(and(eq(channelActors.provider, 'telegram'), eq(channelActors.externalId, verified.userId)))
    .get()
  if (!actor || actor.role === 'blocked' || !actor.accountIds.includes(account.id)) scopeDenied()
  let binding: ChannelBindingDTO | undefined
  if (payload.bindingId) binding = bindingRow(payload.bindingId)
  else {
    // 默认菜单只解析已签名的私聊位置；不猜测最近使用的群，避免误开别的绑定。
    binding = listBindings(account.id).find(
      (b) => b.scope === 'private' && b.chat === verified.userId && (!b.actor || b.actor === verified.userId),
    )
  }
  if (
    !binding ||
    binding.accountId !== account.id ||
    binding.state !== 'active' ||
    (binding.isolation === 'per-user' && binding.actor !== verified.userId)
  )
    scopeDenied()
  if (binding.scope === 'private' && binding.chat !== verified.userId) scopeDenied()
  if (binding.scope === 'group' && !binding.roomId) scopeDenied()
  const id = actor.linkedUserId ?? actor.externalUserId
  if (!id) scopeDenied()
  const scope: SessionScope = binding.roomId
    ? { kind: 'room', roomId: binding.roomId }
    : { kind: 'chat', chatId: binding.chatId }
  asChannelActor(binding, actor, () => {
    db.delete(channelMiniAppReplays).where(lt(channelMiniAppReplays.expiresAt, Date.now())).run()
    const inserted = db
      .insert(channelMiniAppReplays)
      .values({ hash: verified.hash, expiresAt: verified.expiresAt })
      .onConflictDoNothing()
      .returning()
      .all()
    if (!inserted.length) scopeDenied()
    mintScopedSession(c, id, scope)
  })
  return { scope, chatId: binding.chatId, roomId: binding.roomId }
}
