import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

test('旧图片连接迁移成完整 JSON，并保留角色和会话的配置组绑定', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'profile-image-migration-'))
  const source = join(import.meta.dir, '../drizzle')
  const oldMigrations = join(directory, 'old')
  await mkdir(join(oldMigrations, 'meta'), { recursive: true })
  const journal = await Bun.file(join(source, 'meta/_journal.json')).json()
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 20)
  await Bun.write(join(oldMigrations, 'meta/_journal.json'), JSON.stringify(journal))
  for (const entry of journal.entries)
    await cp(join(source, `${entry.tag}.sql`), join(oldMigrations, `${entry.tag}.sql`))
  const sqlite = new Database(':memory:')
  try {
    migrate(drizzle(sqlite), { migrationsFolder: oldMigrations })
    sqlite.exec(`
      PRAGMA foreign_keys=ON;
      INSERT INTO api_presets (id, name, base_url, model, created_at, updated_at) VALUES ('conn', '旧连接', 'http://saved', 'chat', 1, 1);
      INSERT INTO profiles (id, name, image_connection_id, created_at, updated_at) VALUES ('profile', '旧组', 'conn', 1, 1), ('empty', '空组', NULL, 1, 1);
      INSERT INTO characters (id, name, profile_id, created_at, updated_at) VALUES ('char', '角色', 'profile', 1, 1);
      INSERT INTO chats (id, title, character_id, profile_id, created_at, updated_at) VALUES ('chat', '会话', 'char', 'profile', 1, 1);
    `)
    migrate(drizzle(sqlite), { migrationsFolder: source })
    const row = sqlite.query<{ image: string }, []>("SELECT image FROM profiles WHERE id='profile'").get()!
    expect(JSON.parse(row.image)).toEqual({
      source: 'openai',
      connectionId: 'conn',
      url: '',
      model: '',
      comfyWorkflow: null,
      style: '',
    })
    expect(sqlite.query("SELECT image FROM profiles WHERE id='empty'").get()).toEqual({ image: null })
    expect(sqlite.query("SELECT profile_id FROM characters WHERE id='char'").get()).toEqual({ profile_id: 'profile' })
    expect(sqlite.query("SELECT profile_id FROM chats WHERE id='chat'").get()).toEqual({ profile_id: 'profile' })
    expect(sqlite.query('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  }
})
