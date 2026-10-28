import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserInput, updateUserInput } from '@nobot/shared'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { systemDatabase } from '../db/system-client'
import { sessions, users } from '../db/system-schema'
import { env } from '../env'
import { HttpError, notFound } from '../errors'
import { unloadUserExtensions } from '../extensions/registry'
import { t } from '../i18n'
import { stripBidi } from '../lib/input-text'
import { validate } from '../lib/validate'
import { createUser, userDTO } from '../services/auth'
import { cancelUserInstallPreviews, extensionOperation } from '../services/extensions/extension-git'
import { liveHub } from '../services/live/hub'
import { closeUserDatabase, currentUser, runAsUser } from '../user-context'

function findUser(id: string) {
  const user = systemDatabase().select().from(users).where(eq(users.id, id)).get()
  if (user?.kind !== 'normal') throw notFound(t('用户'))
  return user
}
function protectSelf(id: string, forbidden: boolean) {
  if (id === currentUser().id && forbidden)
    throw new HttpError(400, 'SELF_PROTECTED', t('不能删除或禁用自己，也不能取消自己的管理员权限'))
}
export const adminRoutes = new Hono()
  .get('/users', (c) =>
    c.json(systemDatabase().select().from(users).where(eq(users.kind, 'normal')).all().map(userDTO)),
  )
  .post('/users', validate('json', createUserInput), async (c) => c.json(await createUser(c.req.valid('json'))))
  .patch('/users/:id', validate('json', updateUserInput), async (c) => {
    const id = c.req.param('id')
    const input = c.req.valid('json')
    protectSelf(id, input.disabled === true || input.isAdmin === false)
    const passwordHash = input.password ? await Bun.password.hash(input.password, { algorithm: 'argon2id' }) : undefined
    const db = systemDatabase()
    const result = db.transaction((tx) => {
      const user = findUser(id)
      const enabledAdmin = (input.isAdmin ?? user.isAdmin) && !(input.disabled ?? user.disabled)
      if (
        user.isAdmin &&
        !user.disabled &&
        !enabledAdmin &&
        tx
          .select()
          .from(users)
          .where(and(eq(users.isAdmin, true), eq(users.disabled, false)))
          .all().length <= 1
      )
        throw new HttpError(400, 'LAST_ADMIN', t('至少保留一个启用的管理员'))
      if (!Object.keys(input).length) return user
      const updated = tx
        .update(users)
        .set({
          name: input.name !== undefined ? stripBidi(input.name) : undefined,
          disabled: input.disabled,
          isAdmin: input.isAdmin,
          passwordHash,
        })
        .where(eq(users.id, id))
        .returning()
        .get()
      if (input.disabled === true || passwordHash) tx.delete(sessions).where(eq(sessions.userId, id)).run()
      return updated
    })
    if (input.disabled === true || passwordHash) liveHub.closeUser(id)
    if (input.disabled === true) await runAsUser(result, unloadUserExtensions)
    return c.json(userDTO(result))
  })
  .delete('/users/:id', async (c) => {
    const id = c.req.param('id')
    protectSelf(id, true)
    const user = findUser(id)
    // 先让旧会话失效，卸载扩展时保留用户上下文供 dispose 清理 storage。
    const db = systemDatabase()
    db.update(users).set({ disabled: true }).where(eq(users.id, id)).run()
    db.delete(sessions).where(eq(sessions.userId, id)).run()
    liveHub.closeUser(id)
    try {
      await runAsUser(user, () =>
        extensionOperation(async () => {
          await cancelUserInstallPreviews()
          await unloadUserExtensions()
        }),
      )
      closeUserDatabase(user.handle)
      const parent = join(env.dataDir, 'deleted-users')
      await mkdir(parent, { recursive: true })
      await rename(join(env.dataDir, 'users', user.handle), join(parent, `${user.handle}-${Date.now()}`))
      db.delete(users).where(eq(users.id, id)).run()
    } catch (error) {
      db.update(users).set({ disabled: user.disabled }).where(eq(users.id, id)).run()
      throw error
    }
    return c.json({ ok: true })
  })
