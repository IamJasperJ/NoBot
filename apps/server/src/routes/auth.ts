import { changePasswordInput, loginInput } from '@nobot/shared'
import { Hono } from 'hono'
import { getConnInfo } from 'hono/bun'
import { validate } from '../lib/validate'
import {
  authenticatedSession,
  changePassword,
  currentUserDTO,
  login,
  logout,
  writeSessionCookie,
} from '../services/auth'

export const authRoutes = new Hono()
  .post('/login', validate('json', loginInput), async (c) => {
    let ip = 'unknown'
    if (process.env.TRUST_PROXY === '1') ip = c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() || ip
    if (ip === 'unknown') {
      try {
        ip = getConnInfo(c).remote.address ?? 'unknown'
      } catch {
        /* 直接 fetch 测试没有底层连接。 */
      }
    }
    const input = c.req.valid('json')
    const result = await login(input.handle, input.password, ip)
    writeSessionCookie(c, result.token)
    return c.json(result.user)
  })
  .post('/logout', (c) => {
    logout(c)
    return c.json({ ok: true })
  })
  .get('/me', (c) => c.json(currentUserDTO(authenticatedSession(c).user)))
  .put('/password', validate('json', changePasswordInput), async (c) => {
    const { user, session } = authenticatedSession(c)
    const input = c.req.valid('json')
    await changePassword(user.id, session.tokenHash, input.oldPassword, input.newPassword)
    return c.json({ ok: true })
  })
