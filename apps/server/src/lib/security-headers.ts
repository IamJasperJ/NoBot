import type { MiddlewareHandler } from 'hono'
import { miniAppCookie } from '../services/scoped-session'

/** 只限制嵌套来源，不限制脚本，保留扩展注入脚本的能力。 */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next()
  const path = c.req.path
  const miniApp =
    path === '/tg' ||
    path.startsWith('/tg/') ||
    path.startsWith('/assets/') ||
    path.startsWith('/api/miniapp/') ||
    (path.startsWith('/api/') &&
      c.req
        .header('Cookie')
        ?.split(';')
        .some((cookie) => cookie.trim().startsWith(`${miniAppCookie}=`)))
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header(
    'Content-Security-Policy',
    miniApp
      ? "frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org https://webz.telegram.org https://weba.telegram.org"
      : "frame-ancestors 'self'",
  )
  if (
    new URL(c.req.url).protocol === 'https:' ||
    (process.env.TRUST_PROXY === '1' && c.req.header('X-Forwarded-Proto') === 'https')
  )
    c.header('Strict-Transport-Security', 'max-age=31536000')
}
