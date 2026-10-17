import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionDTO, PersonaDTO, PlayPresetDTO, PromptPresetDTO } from '@ai-parter/shared'
import { en } from '../src/i18n/en'

/** 词典自身与说明注释不算调用；延迟翻译的元数据映射也必须完整扫描。 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    if (dir.endsWith('/i18n') && (name === 'index.ts' || name === 'en.ts')) return []
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : []
  })
}
const root = join(import.meta.dir, '../src')
const KEY = /(?<![\w.])t\(\s*'((?:[^'\\\n]|\\.)*)'/g
const keys = new Map<string, string>()
for (const file of sources(root)) {
  for (const match of readFileSync(file, 'utf8').matchAll(KEY)) {
    const key = match[1]!.replace(/\\(.)/g, '$1')
    if (!keys.has(key)) keys.set(key, file.slice(root.length + 1))
  }
}
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('服务端双语', () => {
  test('每个 t() 的键都有英文', () => {
    expect([...keys].filter(([key]) => !en[key]).map(([key, file]) => `${file}: ${key}`)).toEqual([])
  })
  test('英文里的占位符和中文一致', () => {
    expect(Object.entries(en).filter(([zh, text]) => placeholders(zh).join() !== placeholders(text).join())).toEqual([])
  })
  test('英文里没有用不到的键', () => {
    expect(Object.keys(en).filter((key) => !keys.has(key))).toEqual([])
  })

  test('语言切换即时影响错误、扩展设置和种子 DTO，并保留用户修改', async () => {
    // 数据库和扩展注册表是单例，子进程可避免语言和种子数据影响其他测试。
    if (!process.env.SERVER_I18N_TEST_CHILD) {
      const child = Bun.spawn([process.execPath, 'test', 'apps/server/test/i18n.test.ts'], {
        env: { ...process.env, SERVER_I18N_TEST_CHILD: '1' },
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
    const directory = await mkdtemp(join(tmpdir(), 'ai-parter-i18n-'))
    const previous = process.env.DATA_DIR
    process.env.DATA_DIR = directory
    let sqlite: typeof import('../src/db/client').sqlite | undefined
    try {
      const { bootstrap } = await import('../src/bootstrap')
      await bootstrap()
      sqlite = (await import('../src/db/client')).sqlite
      const { app } = await import('../src/app')
      const { t } = await import('../src/i18n')
      const { translateSettingsSchema } = await import('../src/i18n/metadata')
      const { promptBudgetMessage, cardParseMessage } = await import('../src/errors')
      const { readZip } = await import('../src/lib/zip')
      const { loadMessage } = await import('../src/services/chats')
      const { importSprites } = await import('../src/services/sprites')
      const { createCharacter } = await import('../src/services/characters')
      const { insertLog } = await import('../src/services/logs')
      async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
        const response = await app.request(`/api${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        })
        expect(response.status).toBe(200)
        return response.json() as Promise<T>
      }
      const language = (value: 'zh' | 'en') => request('/app-settings', 'PUT', { language: value })
      const missing = async () => {
        const response = await app.request('/api/characters/missing')
        expect(response.status).toBe(404)
        return ((await response.json()) as { error: { message: string } }).error.message
      }
      const summary = async () => (await request<ExtensionDTO[]>('/extensions')).find((e) => e.id === 'summary')!
      const originalPresets = await request<PlayPresetDTO[]>('/play-presets')
      const chatPreset = originalPresets.find((p) => p.name === '普通聊天')!
      const companion = originalPresets.find((p) => p.name === '陪伴')!
      const seededPrompt = (await request<PromptPresetDTO[]>('/presets'))[0]!
      const seededPersona = (await request<PersonaDTO[]>('/personas'))[0]!
      expect(await missing()).toBe('角色不存在')
      expect((await summary()).settingsSchema.find((f) => f.key === 'auto')?.label).toBe('自动总结')
      await language('en')
      expect(await missing()).toBe('Character does not exist')
      const englishExtensions = await request<ExtensionDTO[]>('/extensions')
      expect((await summary()).settingsSchema.find((f) => f.key === 'auto')?.label).toBe('Automatic summaries')
      function checkFields(fields: ExtensionDTO['settingsSchema']) {
        for (const field of fields) {
          for (const value of [
            field.label,
            field.hint,
            field.attachLabel,
            'placeholder' in field ? field.placeholder : '',
          ])
            expect(value ?? '').not.toMatch(/[\u4e00-\u9fff]/)
          if (field.type === 'list') checkFields(field.itemFields)
          if (field.type === 'select')
            for (const option of field.options) expect(option.label).not.toMatch(/[\u4e00-\u9fff]/)
        }
      }
      for (const extension of englishExtensions) {
        expect(extension.name).not.toMatch(/[\u4e00-\u9fff]/)
        expect(extension.description).not.toMatch(/[\u4e00-\u9fff]/)
        checkFields(extension.settingsSchema)
      }
      expect((await request<PlayPresetDTO>(`/play-presets/${chatPreset.id}`)).name).toBe('Regular chat')
      expect((await request<PromptPresetDTO>(`/presets/${seededPrompt.id}`)).name).toBe('Default preset')
      expect(
        (await request<PromptPresetDTO>(`/presets/${seededPrompt.id}`)).data.prompts.find((p) => p.id === 'main')?.name,
      ).toBe('Main prompt')
      expect((await request<PersonaDTO[]>('/personas')).find((p) => p.id === seededPersona.id)?.name).toBe('Traveler')
      expect(
        translateSettingsSchema([{ key: 'test', type: 'string', label: '名称', placeholder: '背景', hint: '模型' }])[0],
      ).toMatchObject({ key: 'test', label: 'Name', placeholder: 'Background', hint: 'Model' })
      expect(() => readZip(new Uint8Array())).toThrow('ZIP central directory not found')
      expect(() => loadMessage('missing')).toThrow('Message does not exist')
      expect(promptBudgetMessage('固定提示词超出预算 20 token（预算 100 token）')).toBe(
        'Fixed prompts exceed the budget by 20 tokens (budget: 100 tokens)',
      )
      expect(cardParseMessage('角色卡缺少名字')).toBe('The character card is missing a name')
      const character = createCharacter({ name: '用户角色' })
      const skipped = await importSprites(character.id, [{ path: 'readme.txt', data: new Uint8Array() }])
      expect(skipped.skipped).toEqual(['readme.txt: not an image'])
      const logId = insertLog({ kind: 'summary', status: 'ok', summary: t('剧情总结') })
      expect((await request<{ summary: string }>(`/logs/${logId}`)).summary).toBe('Story summary')
      const invalid = await app.request('/api/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' }),
      })
      expect(invalid.status).toBe(400)
      expect(JSON.stringify(await invalid.json())).not.toMatch(/[\u4e00-\u9fff]/)
      const invalidGroup = await app.request('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', members: [] }),
      })
      expect(invalidGroup.status).toBe(400)
      expect(JSON.stringify(await invalidGroup.json())).toContain('A group chat must have at least one member')
      await request(`/play-presets/${companion.id}`, 'PATCH', { name: '我的陪伴' })
      await request(`/presets/${seededPrompt.id}`, 'PATCH', { name: '我的生成预设' })
      await request(`/personas/${seededPersona.id}`, 'PATCH', { name: '我的人设' })
      const userPreset = await request<PlayPresetDTO>('/play-presets', 'POST', { name: '普通聊天', data: {} })
      expect(userPreset.name).toBe('普通聊天')
      await language('zh')
      expect(await missing()).toBe('角色不存在')
      expect((await summary()).settingsSchema.find((f) => f.key === 'auto')?.label).toBe('自动总结')
      expect((await request<PlayPresetDTO>(`/play-presets/${chatPreset.id}`)).name).toBe('普通聊天')
      expect((await request<PlayPresetDTO>(`/play-presets/${companion.id}`)).name).toBe('我的陪伴')
      expect((await request<PromptPresetDTO>(`/presets/${seededPrompt.id}`)).name).toBe('我的生成预设')
      expect((await request<PersonaDTO[]>('/personas')).find((p) => p.id === seededPersona.id)?.name).toBe('我的人设')
      await language('en')
      expect((await request<PlayPresetDTO>(`/play-presets/${companion.id}`)).name).toBe('我的陪伴')
      expect((await request<PromptPresetDTO>(`/presets/${seededPrompt.id}`)).name).toBe('我的生成预设')
      expect((await request<PersonaDTO[]>('/personas')).find((p) => p.id === seededPersona.id)?.name).toBe('我的人设')
      expect((await request<PlayPresetDTO>(`/play-presets/${userPreset.id}`)).name).toBe('普通聊天')
      await language('zh')
    } finally {
      sqlite?.close()
      if (previous === undefined) delete process.env.DATA_DIR
      else process.env.DATA_DIR = previous
      await rm(directory, { recursive: true, force: true })
    }
  })
})
