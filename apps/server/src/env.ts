import { join, resolve } from 'node:path'
import { currentPaths, type UserPaths } from './user-context'

/**
 * 运行时配置，都可以用环境变量覆盖。
 * HOST 默认只监听本机；想让局域网里的手机访问，设 HOST=0.0.0.0。
 */
const root = resolve(import.meta.dir, '../../..')

export const env = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '127.0.0.1',
  isProd: process.env.NODE_ENV === 'production',
  dataDir: resolve(process.env.DATA_DIR ?? join(root, 'data')),
  webDist: join(root, 'apps/web/dist'),
  migrationsDir: join(import.meta.dir, '../drizzle'),
}

export const sharedPaths = { models: join(env.dataDir, 'models') }
export const paths = new Proxy({} as UserPaths, {
  get(_target, property) {
    return Reflect.get(currentPaths(), property)
  },
  set(_target, property, value) {
    return Reflect.set(currentPaths(), property, value)
  },
  ownKeys() {
    return Reflect.ownKeys(currentPaths())
  },
  getOwnPropertyDescriptor(_target, property) {
    return Object.getOwnPropertyDescriptor(currentPaths(), property)
  },
})
