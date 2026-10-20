import { existsSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { passwordSchema, userHandleSchema } from '@nobot/shared'
import { eq } from 'drizzle-orm'
import { systemDatabase } from './db/system-client'
import { sessions, users } from './db/system-schema'
import { env } from './env'
import { createUser } from './services/auth'
// 内置扩展在模块初始化时只注册一次；第三方扩展由请求入口懒加载。
import './extensions/registry'

async function moveLegacyData(handle: string) {
  if (!existsSync(join(env.dataDir, 'app.db'))) return
  const destination = join(env.dataDir, 'users', handle)
  await mkdir(destination, { recursive: true })
  const moved: string[] = []
  try {
    for (const name of ['app.db', 'app.db-wal', 'app.db-shm', 'assets', 'tts-cache', 'extensions']) {
      const source = join(env.dataDir, name)
      if (!existsSync(source)) continue
      if (existsSync(join(destination, name))) throw new Error(`迁移目标已存在 / Migration target exists: ${name}`)
      await rename(source, join(destination, name))
      moved.push(name)
    }
  } catch (error) {
    const failures: unknown[] = [error]
    for (const name of moved.reverse()) {
      try {
        await rename(join(destination, name), join(env.dataDir, name))
      } catch (rollbackError) {
        failures.push(rollbackError)
      }
    }
    throw new AggregateError(failures, '旧数据迁移失败 / Legacy data migration failed')
  }
  console.log(`旧数据已迁移到 / Legacy data migrated to: ${destination}`)
}
export async function bootstrap() {
  const db = systemDatabase()
  const password = process.env.NOBOT_ADMIN_PASSWORD
  const existing = db.select().from(users).get()
  if (!existing) {
    if (!password) {
      console.error(
        '【需要初始化】请在 compose 的 environment 中添加 NOBOT_ADMIN_PASSWORD，并在 .env 设置至少 8 位密码后重启。 / SETUP REQUIRED: Add NOBOT_ADMIN_PASSWORD to compose environment, set a password of at least 8 characters in .env, then restart.',
      )
      return
    }
    const handle = userHandleSchema.parse(process.env.NOBOT_ADMIN_USERNAME ?? 'admin')
    passwordSchema.parse(password)
    // 迁移前绝不打开旧库；账号创建失败时允许下一次启动重新接管已迁移的数据。
    await moveLegacyData(handle)
    await createUser({ handle, name: handle, password, isAdmin: true })
    console.log(`初始管理员已创建 / Initial administrator created: ${handle}`)
  } else if (password) {
    if (process.env.NOBOT_ADMIN_RESET !== '1') {
      console.log(
        '管理员密码环境变量已忽略，可以删掉这个环境变量了。 / Admin password environment variable ignored; you can remove it now.',
      )
      return
    }
    const handle = userHandleSchema.parse(process.env.NOBOT_ADMIN_USERNAME ?? 'admin')
    passwordSchema.parse(password)
    const user = db.select().from(users).where(eq(users.handle, handle)).get()
    if (!user) throw new Error('恢复账号不存在 / Recovery account does not exist')
    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' })
    db.transaction((tx) => {
      tx.update(users).set({ passwordHash, disabled: false, isAdmin: true }).where(eq(users.id, user.id)).run()
      tx.delete(sessions).where(eq(sessions.userId, user.id)).run()
    })
    console.log(
      `管理员密码已重置，请移除 NOBOT_ADMIN_RESET 和 NOBOT_ADMIN_PASSWORD。 / Admin password reset; remove NOBOT_ADMIN_RESET and NOBOT_ADMIN_PASSWORD: ${handle}`,
    )
  }
}
