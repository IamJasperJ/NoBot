import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CharacterDTO, type ChatDTO, type ChatPage, characterSheetSchema } from '@nobot/shared'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

test('旧数据库扩展键迁移后，API 与角色卡导出保留属性卡和 VN 配置', async () => {
  // 服务端单例需要独立进程，避免影响其他测试的数据目录和数据库连接。
  if (!process.env.RN1_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', 'apps/server/test/rename-extension-keys.test.ts'], {
      env: { ...process.env, RN1_TEST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, `${out}\n${err}`).toBe(0)
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'nobot-rename-'))
  process.env.DATA_DIR = directory
  const { env } = await import('../src/env')
  const oldMigrations = join(directory, 'old-migrations')
  await mkdir(join(oldMigrations, 'meta'), { recursive: true })
  const journal = await Bun.file(join(env.migrationsDir, 'meta/_journal.json')).json()
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 17)
  await Bun.write(join(oldMigrations, 'meta/_journal.json'), JSON.stringify(journal))
  for (const entry of journal.entries) {
    await cp(join(env.migrationsDir, `${entry.tag}.sql`), join(oldMigrations, `${entry.tag}.sql`))
  }
  await mkdir(join(directory, 'users/test'), { recursive: true })
  const old = new Database(join(directory, 'users/test/app.db'))
  let close = () => old.close()
  try {
    migrate(drizzle(old), { migrationsFolder: oldMigrations })
    const sheet = characterSheetSchema.parse({ hpMax: 34, abilities: { dex: 16 } })
    const vn = { preset: 'Galgame', schema: '{"共同":{"init":7}}' }
    const legacy = {
      ai_parter: { sheet, custom: true },
      ai_parter_vn: vn,
      nobot: { replaced: true },
      nobot_vn: { preset: 'RPG' },
      unrelated: { keep: true },
    }
    old
      .query('INSERT INTO characters (id, name, extensions, raw, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)')
      .run(
        'legacy',
        '旧角色',
        JSON.stringify(legacy),
        JSON.stringify({
          spec: 'chara_card_v2',
          data: { name: '旧角色', extensions: legacy },
        }),
      )
    // 设置和预设没有固定使用旧命名空间，但可保存扩展数据；验证嵌套、数组与所有 JSON 值类型。
    const nested = {
      nested: [legacy, { ai_parter: null }, { ai_parter: false }, { ai_parter_vn: '原值' }],
      text: 'ai_parter',
    }
    old.query('INSERT INTO settings (key, value) VALUES (?, ?)').run('rename-test', JSON.stringify(nested))
    for (const table of ['prompt_presets', 'play_presets']) {
      old.exec(`INSERT INTO ${table} (id, name, data, created_at, updated_at) VALUES ('legacy', '旧预设', '{}', 1, 1)`)
      old.query(`UPDATE ${table} SET data = ? WHERE id = 'legacy'`).run(JSON.stringify(nested))
    }
    old.close()
    close = () => {}
    const { sqlite, initDatabase } = await import('../src/db/client')
    close = () => sqlite.close()
    initDatabase()
    const { seedPlayPresets } = await import('../src/services/playPresets.builtin')
    seedPlayPresets()
    const { app } = await import('../src/app')
    const response = await app.request('/api/characters/legacy')
    expect(response.status).toBe(200)
    const character = (await response.json()) as CharacterDTO
    expect(character.sheet).toEqual(sheet)
    expect(character.extensions).toEqual({ nobot: { sheet, custom: true }, nobot_vn: vn, unrelated: { keep: true } })
    const chatResponse = await app.request('/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId: 'legacy' }),
    })
    expect(chatResponse.status).toBe(200)
    const chat = (await chatResponse.json()) as ChatDTO
    const page = (await (await app.request(`/api/chats/${chat.id}`)).json()) as ChatPage
    expect(page.vars.共同).toBe(7)
    const { resolvePlayPreset } = await import('../src/services/stage')
    expect(resolvePlayPreset(chat.id).data.basic.layout).toBe('adv')
    const { exportCharacter } = await import('../src/services/characters')
    const exported = JSON.parse(new TextDecoder().decode((await exportCharacter('legacy', 'json')).bytes))
    expect(exported.data.extensions.nobot.sheet).toEqual(sheet)
    expect(exported.data.extensions.nobot_vn).toEqual(vn)
    const raw = sqlite.query<{ raw: string }, []>("SELECT raw FROM characters WHERE id = 'legacy'").get()!
    expect(JSON.parse(raw.raw).data.extensions).toEqual(character.extensions)
    const expected = {
      nested: [character.extensions, { nobot: null }, { nobot: false }, { nobot_vn: '原值' }],
      text: 'ai_parter',
    }
    for (const [table, column, condition] of [
      ['settings', 'value', "key = 'rename-test'"],
      ['play_presets', 'data', "id = 'legacy'"],
      ['prompt_presets', 'data', "id = 'legacy'"],
    ]) {
      const read = () =>
        sqlite.query<Record<string, string>, []>(`SELECT ${column} FROM ${table} WHERE ${condition}`).get()!
      expect(JSON.parse(read()[column]!)).toEqual(expected)
      initDatabase()
      expect(JSON.parse(read()[column]!)).toEqual(expected)
    }
  } finally {
    close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
