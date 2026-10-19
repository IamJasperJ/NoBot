import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_MAIN_PROMPT,
  playPresetDataSchema,
  presetDataSchema,
  type StateSchema,
  utilityPromptsSchema,
} from '@nobot/shared'
import {
  LEGACY_DIRECTIVE_TEMPLATES,
  LEGACY_EXTENSION_PROMPTS,
  LEGACY_MAIN_PROMPT,
  LEGACY_STATE_SCHEMAS,
  LEGACY_UTILITY_PROMPTS,
} from './legacy-zh-defaults'

test('内置变量双语标签和旧默认值精确迁移（独立数据库）', async () => {
  // 服务模块持有数据库单例，子进程隔离可避免其他测试提前导入导致共用数据库。
  if (!process.env.LEGACY_PROMPTS_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, LEGACY_PROMPTS_TEST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timeout = setTimeout(() => child.kill(), 20000)
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, `${out}\n${err}`).toBe(0)
    } finally {
      clearTimeout(timeout)
    }
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'nobot-legacy-prompts-'))
  process.env.DATA_DIR = directory
  const { db, sqlite, initDatabase, setSetting, getSetting } = await import('../db/client')
  try {
    initDatabase()
    const { playPresets, promptPresets, generationLogs } = await import('../db/schema')
    const { SETTING_KEYS, setAppSettings } = await import('./settings')
    const { BUILTIN_PLAY_PRESETS } = await import('./playPresets.builtin')
    const { migrateLegacyPrompts } = await import('./migrate-legacy-prompts')
    const { bootstrap } = await import('../bootstrap')
    for (const language of ['zh', 'en'] as const) {
      setAppSettings({ language })
      for (const def of BUILTIN_PLAY_PRESETS.filter((def) => ['galgame', 'rpg', 'dnd5e'].includes(def.key))) {
        const schema: StateSchema = JSON.parse(def.build().state.schema)
        for (const [key, field] of Object.entries(schema)) {
          expect(key).toMatch(/^[a-zA-Z.]+$/)
          expect(field.label).toBeTruthy()
          expect(/[\p{Script=Han}]/u.test(field.label!)).toBe(language === 'zh')
          const { label: _label, ...modelFields } = field
          expect(JSON.stringify(modelFields)).not.toMatch(/[\p{Script=Han}]/u)
          if (typeof field.max === 'string') expect(schema[field.max]).toBeDefined()
        }
      }
    }
    const original = presetDataSchema.parse({ utility: LEGACY_UTILITY_PROMPTS })
    original.prompts.find((prompt) => prompt.id === 'main')!.content = LEGACY_MAIN_PROMPT
    original.prompts.find((prompt) => prompt.id === 'auxiliary')!.content = LEGACY_MAIN_PROMPT
    const custom = structuredClone(original)
    custom.utility.groupNudge += ' '
    custom.prompts.find((prompt) => prompt.id === 'main')!.content += ' '
    const row = (id: string) => ({ id, name: id, createdAt: 1, updatedAt: 2 })
    db.insert(promptPresets)
      .values([
        { ...row('old'), data: original },
        { ...row('custom'), data: custom },
      ])
      .run()
    const expectedSchemas = new Map<string, string>()
    for (const [key, schemas] of Object.entries(LEGACY_STATE_SCHEMAS)) {
      for (const [version, schema] of schemas.entries()) {
        for (const copy of [false, true]) {
          const id = `${key}-${version}-${copy}`
          const data = playPresetDataSchema.parse({
            state: { schema },
            directives: { template: Object.values(LEGACY_DIRECTIVE_TEMPLATES)[version] },
          })
          db.insert(playPresets)
            .values({ ...row(id), name: copy ? 'RPG 副本' : id, data, builtinKey: copy ? null : key })
            .run()
          expectedSchemas.set(id, BUILTIN_PLAY_PRESETS.find((def) => def.key === key)!.build().state.schema)
        }
      }
    }
    const customPlay = playPresetDataSchema.parse({
      state: { schema: `${LEGACY_STATE_SCHEMAS.rpg[0]} ` },
      directives: { template: `${LEGACY_DIRECTIVE_TEMPLATES.xml} ` },
    })
    db.insert(playPresets)
      .values({ ...row('custom-play'), data: customPlay })
      .run()
    for (const [id, defaults] of Object.entries(LEGACY_EXTENSION_PROMPTS)) setSetting(`ext:${id}`, defaults)
    setSetting('ext:image-gen', { ...LEGACY_EXTENSION_PROMPTS['image-gen'], tpl_face: '用户改过的描述', width: 512 })
    setSetting('extdata:summary', { prompt: LEGACY_EXTENSION_PROMPTS.summary.prompt })
    setSetting('ext:other', { prompt: LEGACY_EXTENSION_PROMPTS.summary.prompt })
    // 通过实际启动入口验证迁移在播种后执行。
    await bootstrap()
    const prompts = db.select().from(promptPresets).all()
    const migrated = prompts.find((item) => item.id === 'old')!.data
    expect(migrated.utility).toEqual(utilityPromptsSchema.parse({}))
    expect(migrated.prompts.find((prompt) => prompt.id === 'main')!.content).toBe(DEFAULT_MAIN_PROMPT)
    expect(migrated.prompts.find((prompt) => prompt.id === 'auxiliary')!.content).toBe(LEGACY_MAIN_PROMPT)
    const kept = prompts.find((item) => item.id === 'custom')!.data
    expect(kept.utility.groupNudge).toBe(custom.utility.groupNudge)
    expect(kept.prompts.find((prompt) => prompt.id === 'main')!.content).toBe(
      custom.prompts.find((prompt) => prompt.id === 'main')!.content,
    )
    for (const item of db.select().from(playPresets).all()) {
      if (expectedSchemas.has(item.id)) {
        expect(item.data.state.schema).toBe(expectedSchemas.get(item.id)!)
        expect(item.data.directives.template).toBe('')
      }
      if (item.id === 'custom-play') expect(item.data).toEqual(customPlay)
    }
    expect(getSetting('ext:summary')).toEqual({})
    expect(getSetting('ext:image-gen')).toEqual({ tpl_face: '用户改过的描述', width: 512 })
    expect(getSetting('extdata:summary')).toEqual({ prompt: LEGACY_EXTENSION_PROMPTS.summary.prompt })
    expect(getSetting('ext:other')).toEqual({ prompt: LEGACY_EXTENSION_PROMPTS.summary.prompt })
    expect(getSetting(SETTING_KEYS.legacyPromptsMigrated)).toBe(1)
    const logs = db.select().from(generationLogs).all()
    // 两份生成预设分别更新 7 / 5 个字段，12 份玩法各 2 个字段，扩展共删除 10 个键。
    expect(logs).toHaveLength(1)
    expect(logs[0]!.summary).toBe('Replaced 46 legacy Chinese default prompts with English')
    setSetting('ext:summary', LEGACY_EXTENSION_PROMPTS.summary)
    expect(migrateLegacyPrompts()).toBe(0)
    await bootstrap()
    expect(getSetting('ext:summary')).toEqual(LEGACY_EXTENSION_PROMPTS.summary)
    expect(db.select().from(generationLogs).all()).toEqual(logs)
  } finally {
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  }
})
