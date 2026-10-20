import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { env } from '../env'
import * as schema from './system-schema'

let connection: { sqlite: Database; db: ReturnType<typeof drizzle<typeof schema>> } | undefined
export function systemDatabase() {
  if (connection) return connection.db
  mkdirSync(env.dataDir, { recursive: true })
  const sqlite = new Database(join(env.dataDir, 'system.db'), { create: true, strict: true })
  try {
    sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON')
    const db = drizzle(sqlite, { schema })
    migrate(db, { migrationsFolder: join(import.meta.dir, '../../drizzle-system') })
    connection = { sqlite, db }
    return db
  } catch (error) {
    sqlite.close()
    throw error
  }
}
