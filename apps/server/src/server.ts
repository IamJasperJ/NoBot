import { join } from 'node:path'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { getCookie } from 'hono/cookie'
import { app as api } from './app'
import { env } from './env'
import { HttpError } from './errors'
import { ensureUserExtensions, forwardPublicExtension, resumeBuiltinBackgrounds } from './extensions/registry'
import { t } from './i18n'
import { requestLanguage } from './i18n/request-language'
import { securityHeaders } from './lib/security-headers'
import { adminRoutes } from './routes/admin'
import { authRoutes } from './routes/auth'
import { miniAppRoutes } from './routes/miniapp'
import { authenticatedSession, requireAdmin } from './services/auth'
import { logError } from './services/logs'
import { resumeRoomStates } from './services/rooms'
import { enforceScope, miniAppCookie } from './services/scoped-session'
import { runAsUser } from './user-context'

export function createServer() {
  resumeRoomStates()
  void resumeBuiltinBackgrounds()
  const server = new Hono()
  server.use('*', securityHeaders)
  server.onError((err, c) => {
    if (err instanceof HttpError)
      return c.json({ error: { code: err.code, message: err.message, ...err.details } }, err.status)
    logError(`${c.req.method} ${c.req.path}`, err)
    return c.json({ error: { code: 'INTERNAL', message: t('服务器内部错误：{error}', { error: err.message }) } }, 500)
  })
  server.use('/api/*', (c, next) =>
    requestLanguage.run(c.req.header('Accept-Language')?.toLowerCase().startsWith('en') ? 'en' : 'zh', async () => {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
        // 优先看浏览器给的 Sec-Fetch-Site：它不受反向代理改写 Host 的影响；老浏览器没有时再比对 Origin 和 Host
        const site = c.req.header('Sec-Fetch-Site')
        if (site === 'cross-site') throw new HttpError(403, 'FORBIDDEN', t('不允许跨站请求'))
        const origin = c.req.header('Origin')
        if (!site && origin) {
          let host: string | undefined
          try {
            host = new URL(origin).host
          } catch {
            /* 无效 Origin 同样拒绝。 */
          }
          const hosts = [c.req.header('Host') ?? new URL(c.req.url).host, c.req.header('X-Forwarded-Host')]
          if (!host || !hosts.includes(host)) throw new HttpError(403, 'FORBIDDEN', t('不允许跨站请求'))
        }
      }
      const publicRoute =
        (c.req.method === 'GET' && c.req.path === '/api/health') ||
        (c.req.method === 'POST' && ['/api/auth/login', '/api/auth/logout'].includes(c.req.path))
      if (publicRoute && !getCookie(c, miniAppCookie)) return next()
      const { user, session } = authenticatedSession(c)
      return runAsUser(user, async () => {
        if (session.scope) await enforceScope(c, session.scope)
        if (c.req.path === '/api/admin' || c.req.path.startsWith('/api/admin/')) requireAdmin(user)
        await ensureUserExtensions()
        await next()
        // 资源文件名是全局唯一的 ULID（TTS 缓存按内容哈希），不同用户不会撞 URL，可以继续长期缓存，
        // 但只能存在浏览器里（private），不能让中间的代理缓存；其他接口一律不缓存。
        const cache = c.res.headers.get('Cache-Control')
        c.header(
          'Cache-Control',
          cache?.includes('immutable') ? cache.replace('public', 'private') : 'private, no-store',
        )
      })
    }),
  )
  server.all('/hooks/:id/:handle/*', (c) =>
    forwardPublicExtension(c.req.param('id'), c.req.param('handle'), c.req.raw, c.env),
  )
  server.route('/api/miniapp', miniAppRoutes)
  server.route('/api/auth', authRoutes)
  server.route('/api/admin', adminRoutes)
  server.route('/', api)
  // 登录页本身无需会话，静态文件只在 API 路由之后处理。
  if (env.isProd) server.use('/*', serveStatic({ root: env.webDist }))
  server.notFound((c) => {
    if (c.req.path.startsWith('/api/'))
      return c.json(
        {
          error: {
            code: 'NOT_FOUND',
            message: t('接口不存在：{method} {path}', { method: c.req.method, path: c.req.path }),
          },
        },
        404,
      )
    if (env.isProd) return c.html(Bun.file(join(env.webDist, 'index.html')).text())
    return c.text('Not Found', 404)
  })
  return server
}
