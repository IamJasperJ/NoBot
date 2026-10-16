import { Database } from 'bun:sqlite'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { monotonicFactory } from 'ulid'
import { env, paths } from '../env'
import * as schema from './schema'

/** 原始的 SQLite 连接。递归查询这类 Drizzle 不好表达的 SQL 直接用它写 */
export const sqlite = new Database(paths.db, { create: true, strict: true })

// WAL 模式：读写互不阻塞；外键默认是关的，要手动打开才会级联删除
sqlite.exec('PRAGMA journal_mode = WAL')
sqlite.exec('PRAGMA synchronous = NORMAL')
sqlite.exec('PRAGMA foreign_keys = ON')

export const db = drizzle(sqlite, { schema })

/** 单调递增的 ULID：同一毫秒内生成的 id 也保证有序，兄弟节点排序靠它 */
export const newId = monotonicFactory()

/** 启动时执行：跑迁移、清理上次崩溃留下的状态。默认数据的写入在 bootstrap.ts */
export function initDatabase() {
  migrate(db, { migrationsFolder: env.migrationsDir })
  // 上次进程退出时还在生成的消息，标记为中止，避免界面上一直转圈
  sqlite.exec(`UPDATE messages SET status = 'aborted' WHERE status = 'streaming'`)
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
