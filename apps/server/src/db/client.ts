import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'
import { currentContext, type UserContext } from '../user-context'
import * as schema from './schema'

function forward<K extends 'db' | 'sqlite'>(key: K): UserContext[K] {
  return new Proxy({} as UserContext[K], {
    get(_target, property) {
      const target = currentContext()[key]
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
export const db = forward('db')
export const sqlite = forward('sqlite')
export const newId = monotonicFactory()

/** 兼容直接初始化数据库的测试；首次访问连接时已完成迁移与种子数据。 */
export function initDatabase() {
  currentContext()
}

export function getSetting<T>(key: string): T | undefined {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()
  return row?.value as T | undefined
}

export function setSetting(key: string, value: unknown) {
  db.insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run()
}
