import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCardFile, readPngTextChunks, writePngTextChunks } from '@ai-parter/core'
import type {
  CharacterDTO,
  CharacterImportPreview,
  GroupDTO,
  LorebookDTO,
  LorebookEntryDTO,
  PersonaDTO,
  PromptPresetDTO,
  WorldInfoSettings,
} from '@ai-parter/shared'
import sharp from 'sharp'

let app: typeof import('../src/app').app
let sqlite: typeof import('../src/db/client').sqlite
let directory: string
const previousDataDir = process.env.DATA_DIR
let png: Uint8Array

function request(path: string, method = 'GET', data?: unknown) {
  return app.request(`/api${path}`, {
    method,
    ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  })
}
async function json<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await request(path, method, data)
  const value: unknown = await response.json()
  expect(response.status, JSON.stringify(value)).toBe(200)
  return value as T
}
function upload(path: string, bytes: Uint8Array, name: string) {
  const form = new FormData()
  form.set('file', new File([Buffer.from(bytes)], name))
  return app.request(`/api${path}`, { method: 'POST', body: form })
}
async function uploadJson<T>(path: string, bytes: Uint8Array, name: string): Promise<T> {
  const response = await upload(path, bytes, name)
  const value: unknown = await response.json()
  expect(response.status, JSON.stringify(value)).toBe(200)
  return value as T
}
async function error(path: string, method: string, status: number, code: string, data?: unknown) {
  const response = await request(path, method, data)
  expect(response.status).toBe(status)
  const value = (await response.json()) as { error: { code: string; message: string } }
  expect(value.error.code).toBe(code)
  expect(value.error.message).toMatch(/[\u4e00-\u9fff]/)
}
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

describe.skipIf(!process.env.CRUD_TEST_CHILD)('后端 CRUD 接口', () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ai-parter-crud-'))
    process.env.DATA_DIR = directory
    const client = await import('../src/db/client')
    sqlite = client.sqlite
    client.initDatabase()
    const { seedPlayPresets } = await import('../src/services/playPresets.builtin')
    seedPlayPresets()
    app = (await import('../src/app')).app
    png = await sharp({ create: { width: 12, height: 18, channels: 3, background: '#ffccaa' } })
      .png()
      .toBuffer()
  })
  afterAll(async () => {
    sqlite?.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  test('预设创建、读取、局部更新、复制、导入导出和默认项删除规则', async () => {
    const first = await json<PromptPresetDTO>('/presets', 'POST', { name: '中文预设', data: {} })
    expect(first.isDefault).toBe(true)
    expect(first.data.samplers.temperature).toBeNumber()
    expect(first.data.prompts.find((prompt) => prompt.id === 'main')?.content).toContain(
      'Write in the same language as the conversation.',
    )
    expect(first.data.utility.newChat).toBe('[Start a new conversation]')
    await error(`/presets/${first.id}`, 'DELETE', 400, 'LAST_PRESET')
    const copy = await json<PromptPresetDTO>(`/presets/${first.id}/duplicate`, 'POST')
    expect(copy.name).toBe('中文预设 副本')
    expect(copy.data).toEqual(first.data)
    const updated = await json<PromptPresetDTO>(`/presets/${copy.id}`, 'PATCH', { name: '另一个' })
    expect(updated.data).toEqual(first.data)
    await json(`/presets/${copy.id}/default`, 'POST')
    expect((await json<PromptPresetDTO>(`/presets/${copy.id}`)).isDefault).toBe(true)
    const exported = await request(`/presets/${first.id}/export`)
    expect(exported.headers.get('Content-Disposition')).toContain(
      `filename*=UTF-8''${encodeURIComponent('中文预设')}.json`,
    )
    const imported = await uploadJson<PromptPresetDTO>(
      '/presets/import',
      new Uint8Array(await exported.arrayBuffer()),
      '往返.json',
    )
    expect(imported.name).toBe('往返')
    expect(imported.data).toEqual(first.data)
    const changed = { ...first.data, samplers: { ...first.data.samplers, temperature: 0.42 } }
    expect((await json<PromptPresetDTO>(`/presets/${first.id}`, 'PATCH', { data: changed })).data).toEqual(changed)
    // 已保存的中文提示词在读取、复制和导入时都应保持原文。
    changed.prompts = changed.prompts.map((prompt) =>
      prompt.id === 'main' ? { ...prompt, content: '用户保存的中文提示词' } : prompt,
    )
    changed.utility = { ...changed.utility, newChat: '[用户自定义开场]' }
    await json(`/presets/${first.id}`, 'PATCH', { data: changed })
    const preserved = await json<PromptPresetDTO>(`/presets/${first.id}/duplicate`, 'POST')
    expect(preserved.data).toEqual(changed)
    await json(`/presets/${preserved.id}`, 'DELETE')
    await json(`/presets/${copy.id}`, 'DELETE')
    expect((await json<PromptPresetDTO>(`/presets/${first.id}`)).isDefault).toBe(true)
    await json(`/presets/${imported.id}`, 'DELETE')
    expect(await json<PromptPresetDTO[]>('/presets')).toHaveLength(1)
  })

  test('人设创建、更新、默认切换、头像上传删除和最后一个保护', async () => {
    const first = await json<PersonaDTO>('/personas', 'POST', { name: '旅人', description: '原始描述' })
    const second = await json<PersonaDTO>('/personas', 'POST', { name: '骑士' })
    const changed = await json<PersonaDTO>(`/personas/${first.id}`, 'PATCH', { name: '旅行者' })
    expect(changed.description).toBe('原始描述')
    const avatar = await uploadJson<PersonaDTO>(`/personas/${first.id}/avatar`, png, '头像.png')
    expect(avatar.avatarUrl).toContain('.webp?v=')
    const image = await request(avatar.avatarUrl!.replace('/api', ''))
    expect(image.status).toBe(200)
    expect(await Bun.file(join(directory, 'assets/avatars', `${first.id}.png`)).exists()).toBe(true)
    expect((await json<PersonaDTO>(`/personas/${first.id}/avatar`, 'DELETE')).avatarUrl).toBeNull()
    expect(await Bun.file(join(directory, 'assets/avatars', `${first.id}.webp`)).exists()).toBe(false)
    await json(`/personas/${second.id}/default`, 'POST')
    expect((await json<PersonaDTO[]>('/personas')).find((row) => row.id === second.id)?.isDefault).toBe(true)
    await uploadJson<PersonaDTO>(`/personas/${second.id}/avatar`, png, '头像.png')
    await json(`/personas/${second.id}`, 'DELETE')
    expect(await Bun.file(join(directory, 'assets/avatars', `${second.id}.png`)).exists()).toBe(false)
    expect(await Bun.file(join(directory, 'assets/avatars', `${second.id}.webp`)).exists()).toBe(false)
    expect((await json<PersonaDTO[]>('/personas'))[0]?.isDefault).toBe(true)
    await error(`/personas/${first.id}`, 'DELETE', 400, 'LAST_PERSONA')
  })

  test('世界书条目增删改、完整排序、两种格式导入导出与设置', async () => {
    const book = await json<LorebookDTO>('/lorebooks', 'POST', { name: '设定集', description: '保留描述' })
    const changed = await json<LorebookDTO>(`/lorebooks/${book.id}`, 'PATCH', { isGlobal: true })
    expect(changed.description).toBe('保留描述')
    const first = await json<LorebookEntryDTO>(`/lorebooks/${book.id}/entries`, 'POST', {
      content: '原始内容',
      keys: ['龙'],
      constant: true,
    })
    const second = await json<LorebookEntryDTO>(`/lorebooks/${book.id}/entries`, 'POST', {})
    const patched = await json<LorebookEntryDTO>(`/lorebooks/entries/${first.id}`, 'PATCH', { comment: '备注' })
    expect(patched.content).toBe('原始内容')
    expect(patched.keys).toEqual(['龙'])
    expect(patched.constant).toBe(true)
    await json(`/lorebooks/${book.id}/entries/reorder`, 'POST', { ids: [second.id, first.id] })
    const detail = await json<{ lorebook: LorebookDTO; entries: LorebookEntryDTO[] }>(`/lorebooks/${book.id}`)
    expect(detail.entries.map((row) => row.id)).toEqual([second.id, first.id])
    expect(detail.lorebook.entryCount).toBe(2)
    await error(`/lorebooks/${book.id}/entries/reorder`, 'POST', 400, 'BAD_REQUEST', { ids: [first.id, first.id] })
    await error(`/lorebooks/${book.id}/entries/reorder`, 'POST', 400, 'BAD_REQUEST', { ids: [first.id] })
    const exported = await request(`/lorebooks/${book.id}/export`)
    const imported = await uploadJson<LorebookDTO>(
      '/lorebooks/import',
      new Uint8Array(await exported.arrayBuffer()),
      '另一个.json',
    )
    expect(imported.name).toBe('设定集')
    const roundtrip = await json<typeof detail>(`/lorebooks/${imported.id}`)
    expect(roundtrip.entries.map(({ id: _id, lorebookId: _bookId, ...data }) => data)).toEqual(
      detail.entries.map(({ id: _id, lorebookId: _bookId, ...data }) => data),
    )
    const embedded = await uploadJson<LorebookDTO>(
      '/lorebooks/import',
      encode({ entries: [{ keys: ['城'], content: '城市' }] }),
      '内嵌.json',
    )
    expect(embedded.name).toBe('内嵌')
    expect(embedded.entryCount).toBe(1)
    await json(`/lorebooks/entries/${second.id}`, 'DELETE')
    expect((await json<typeof detail>(`/lorebooks/${book.id}`)).entries).toHaveLength(1)
    expect((await json<LorebookDTO[]>('/lorebooks')).some((row) => row.id === book.id)).toBe(true)
    const settings = await json<WorldInfoSettings>('/lorebooks/settings')
    expect((await json<WorldInfoSettings>('/lorebooks/settings', 'PUT', { ...settings, scanDepth: 8 })).scanDepth).toBe(
      8,
    )
    for (const id of [book.id, imported.id, embedded.id]) await json(`/lorebooks/${id}`, 'DELETE')
  })

  test('PNG 卡显式选择 link 关联世界书，角色复制、更新和双格式导出', async () => {
    const raw = {
      spec: 'chara_card_v3',
      data: {
        name: '白龙',
        description: '守护山谷',
        personality: '温和',
        creator: '作者',
        character_version: '2',
        first_mes: '你好',
        alternate_greetings: ['欢迎'],
        extensions: {
          unknown: '保留',
          sd_character_prompt: '白龙，银色鳞片',
          talkativeness: 0.8,
          depth_prompt: { prompt: '角色备注', depth: 3, role: 'assistant' },
        },
        character_book: { name: '龙的世界', entries: [{ keys: ['山谷'], content: '龙居住的地方' }] },
      },
    }
    const cardPng = writePngTextChunks(png, { ccv3: Buffer.from(JSON.stringify(raw)).toString('base64') })
    const imported = await uploadJson<CharacterDTO>('/characters/import?lorebook=link', cardPng, '龙.png')
    expect(imported.extensions).toEqual({ unknown: '保留', sd_character_prompt: '白龙，银色鳞片' })
    expect(imported.lorebookIds).toHaveLength(1)
    expect(imported.talkativeness).toBe(0.8)
    expect(imported.characterNote).toBe('角色备注')
    const book = await json<{ lorebook: LorebookDTO; entries: LorebookEntryDTO[] }>(
      `/lorebooks/${imported.lorebookIds[0]}`,
    )
    expect(book.lorebook.name).toBe('龙的世界')
    expect(book.entries[0]?.content).toBe('龙居住的地方')
    expect(
      new Uint8Array(await Bun.file(join(directory, 'assets/avatars', `${imported.id}.png`)).arrayBuffer()),
    ).toEqual(new Uint8Array(cardPng))
    const copy = await json<CharacterDTO>(`/characters/${imported.id}/duplicate`, 'POST')
    expect(copy.name).toBe('白龙 副本')
    expect(copy.extensions).toEqual(imported.extensions)
    expect(copy.lorebookIds).toEqual(imported.lorebookIds)
    expect(copy.avatarUrl).toContain(copy.id)
    const updated = await json<CharacterDTO>(`/characters/${imported.id}`, 'PATCH', { scenario: '森林' })
    expect(updated.description).toBe('守护山谷')
    expect(updated.creator).toBe('作者')
    const response = await request(`/characters/${imported.id}/export?format=png`)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Content-Disposition')).toContain(encodeURIComponent('白龙'))
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect([...readPngTextChunks(bytes).keys()]).toEqual(expect.arrayContaining(['chara', 'ccv3']))
    const parsed = parseCardFile(bytes)
    const {
      id: _id,
      avatarUrl: _avatar,
      lorebookIds: _books,
      createdAt: _created,
      updatedAt: _updated,
      talkativeness: _talk,
      characterNote: _note,
      characterNoteDepth: _depth,
      characterNoteRole: _role,
      defaultPersonaId: _persona,
      extensions: _extensions,
      ...fields
    } = updated
    expect(parsed.fields).toEqual(fields)
    expect(parsed.extensions).toEqual(imported.extensions)
    expect(parsed.extras).toMatchObject({
      talkativeness: 0.8,
      characterNote: '角色备注',
      characterNoteDepth: 3,
      characterNoteRole: 'assistant',
    })
    expect(parsed.characterBook).toMatchObject({ name: '龙的世界' })
    const jsonExport = await request(`/characters/${imported.id}/export?format=json`)
    expect(parseCardFile(new Uint8Array(await jsonExport.arrayBuffer())).fields).toEqual(fields)
    const replaced = await json<CharacterDTO>(`/characters/${imported.id}`, 'PATCH', { extensions: { custom: true } })
    expect(replaced.extensions).toEqual({ custom: true })
    const replacedExport = await request(`/characters/${imported.id}/export?format=json`)
    expect(parseCardFile(new Uint8Array(await replacedExport.arrayBuffer())).extensions).toEqual({ custom: true })
    const createdWithExtensions = await json<CharacterDTO>('/characters', 'POST', {
      name: '扩展角色',
      extensions: { sd_character_prompt: '森林' },
    })
    expect(createdWithExtensions.extensions).toEqual({ sd_character_prompt: '森林' })
    await json(`/characters/${createdWithExtensions.id}`, 'DELETE')
    const blank = await json<CharacterDTO>('/characters', 'POST', { name: '空白角色' })
    const placeholder = await request(`/characters/${blank.id}/export?format=png`)
    const metadata = await sharp(Buffer.from(await placeholder.arrayBuffer())).metadata()
    expect([metadata.width, metadata.height]).toEqual([400, 600])
    expect((await uploadJson<CharacterDTO>(`/characters/${blank.id}/avatar`, png, '新头像.png')).avatarUrl).toBeString()
    const jsonCard = await uploadJson<CharacterDTO>(
      '/characters/import?lorebook=link',
      encode({ name: 'JSON 角色', description: '', character_book: { entries: [] } }),
      '角色.json',
    )
    expect((await json<{ lorebook: LorebookDTO }>(`/lorebooks/${jsonCard.lorebookIds[0]}`)).lorebook.name).toBe(
      'JSON 角色 的世界书',
    )
    expect((await json<CharacterDTO[]>(`/characters`)).some((row) => row.id === blank.id)).toBe(true)
    expect((await json<CharacterDTO>(`/characters/${blank.id}`)).name).toBe('空白角色')
    await json(`/characters/${imported.id}`, 'PATCH', { lorebookIds: [] })
    const withoutBook = await request(`/characters/${imported.id}/export?format=json`)
    expect(parseCardFile(new Uint8Array(await withoutBook.arrayBuffer())).characterBook).toEqual(
      raw.data.character_book,
    )
    for (const id of [imported.id, copy.id, blank.id, jsonCard.id]) await json(`/characters/${id}`, 'DELETE')
    expect(await Bun.file(join(directory, 'assets/avatars', `${imported.id}.png`)).exists()).toBe(false)
    expect(await Bun.file(join(directory, 'assets/avatars', `${copy.id}.webp`)).exists()).toBe(false)
    await json(`/lorebooks/${book.lorebook.id}`, 'DELETE')
    await json(`/lorebooks/${jsonCard.lorebookIds[0]}`, 'DELETE')
  })

  test('预读 PNG 和各版本 JSON 不入库，返回世界书统计、缺省名和无世界书信息', async () => {
    const beforeCharacters = await json<CharacterDTO[]>('/characters')
    const beforeBooks = await json<LorebookDTO[]>('/lorebooks')
    const data = { name: '预读角色', description: '', character_book: { entries: [{ keys: ['城'], content: '城市' }] } }
    for (const [spec, raw] of [
      ['v1', data],
      ['v2', { spec: 'chara_card_v2', data }],
      ['v3', { spec: 'chara_card_v3', data }],
    ] as const) {
      expect(await uploadJson<CharacterImportPreview>('/characters/import/preview', encode(raw), '卡.json')).toEqual({
        name: '预读角色',
        spec,
        hasAvatar: false,
        lorebook: { name: '预读角色 的世界书', entryCount: 1 },
      })
    }
    const cardPng = writePngTextChunks(png, {
      chara: Buffer.from(
        JSON.stringify({
          spec: 'chara_card_v2',
          data: { ...data, character_book: { name: '命名世界书', entries: [] } },
        }),
      ).toString('base64'),
    })
    expect(await uploadJson<CharacterImportPreview>('/characters/import/preview', cardPng, '卡.png')).toEqual({
      name: '预读角色',
      spec: 'v2',
      hasAvatar: true,
      lorebook: { name: '命名世界书', entryCount: 0 },
    })
    expect(
      await uploadJson<CharacterImportPreview>(
        '/characters/import/preview',
        encode({ name: '无世界书', description: '' }),
        '卡.json',
      ),
    ).toEqual({
      name: '无世界书',
      spec: 'v1',
      hasAvatar: false,
      lorebook: null,
    })
    for (const bytes of [
      encode({ name: '普通 JSON' }),
      png,
      encode({ ...data, character_book: { entries: '错误' } }),
    ]) {
      const response = await upload('/characters/import/preview', bytes, '坏卡.json')
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'BAD_CARD' } })
    }
    expect(await json<CharacterDTO[]>('/characters')).toEqual(beforeCharacters)
    expect(await json<LorebookDTO[]>('/lorebooks')).toEqual(beforeBooks)
  })

  test('只导入世界书不关联，显式与缺省 skip 不入库世界书，导出保留内嵌原始数据', async () => {
    const raw = {
      spec: 'chara_card_v3',
      data: {
        name: '选择导入',
        character_book: { name: '原始世界书', custom: '保留', entries: [{ keys: ['龙'], content: '内容' }] },
      },
    }
    for (const mode of ['import', 'skip', undefined] as const) {
      const beforeBooks = await json<LorebookDTO[]>('/lorebooks')
      const imported = await uploadJson<CharacterDTO>(
        `/characters/import${mode ? `?lorebook=${mode}` : ''}`,
        encode(raw),
        '卡.json',
      )
      expect(imported.lorebookIds).toEqual([])
      const books = await json<LorebookDTO[]>('/lorebooks')
      expect(books).toHaveLength(beforeBooks.length + (mode === 'import' ? 1 : 0))
      const created = books.find((book) => !beforeBooks.some((before) => before.id === book.id))
      if (mode === 'import') {
        expect(created).toMatchObject({ name: '原始世界书', entryCount: 1 })
        const detail = await json<{ entries: LorebookEntryDTO[] }>(`/lorebooks/${created!.id}`)
        expect(detail.entries[0]?.content).toBe('内容')
      }
      for (const format of ['json', 'png']) {
        const exported = await request(`/characters/${imported.id}/export?format=${format}`)
        expect(parseCardFile(new Uint8Array(await exported.arrayBuffer())).characterBook).toEqual(
          raw.data.character_book,
        )
      }
      await json(`/characters/${imported.id}`, 'DELETE')
      if (created) await json(`/lorebooks/${created.id}`, 'DELETE')
    }
    await error('/characters/import?lorebook=invalid', 'POST', 400, 'VALIDATION')
  })

  test('群组成员按顺序整体替换，非法关联回滚，删除角色清理成员', async () => {
    const a = await json<CharacterDTO>('/characters', 'POST', { name: '甲', talkativeness: 0.3 })
    const b = await json<CharacterDTO>('/characters', 'POST', { name: '乙' })
    const group = await json<GroupDTO>('/groups', 'POST', {
      name: '探险队',
      members: [{ characterId: a.id }, { characterId: b.id, muted: true }],
    })
    expect(group.members.map((row) => row.characterId)).toEqual([a.id, b.id])
    expect(group.members[0]?.talkativeness).toBe(0.3)
    const replaced = await json<GroupDTO>(`/groups/${group.id}`, 'PATCH', { members: [{ characterId: b.id }] })
    expect(replaced.members).toHaveLength(1)
    expect(replaced.members[0]?.muted).toBe(false)
    expect((await json<GroupDTO>(`/groups/${group.id}`, 'PATCH', { scenarioOverride: '山洞' })).members).toEqual(
      replaced.members,
    )
    await error(`/groups/${group.id}`, 'PATCH', 404, 'NOT_FOUND', {
      name: '不应写入',
      members: [{ characterId: '不存在' }],
    })
    expect((await json<GroupDTO>(`/groups/${group.id}`)).name).toBe('探险队')
    await error(`/groups/${group.id}`, 'PATCH', 400, 'VALIDATION', {
      members: [{ characterId: b.id }, { characterId: b.id }],
    })
    expect(await json<GroupDTO[]>('/groups')).toHaveLength(1)
    await json(`/characters/${b.id}`, 'DELETE')
    expect((await json<GroupDTO>(`/groups/${group.id}`)).members).toHaveLength(0)
    await json(`/groups/${group.id}`, 'DELETE')
    await json(`/characters/${a.id}`, 'DELETE')
  })

  test('各资源不存在、请求校验、无效上传和关联错误', async () => {
    for (const resource of ['presets', 'characters', 'lorebooks', 'groups']) {
      await error(`/${resource}/missing`, 'GET', 404, 'NOT_FOUND')
      await error(`/${resource}/missing`, 'PATCH', 404, 'NOT_FOUND', {})
      await error(`/${resource}/missing`, 'DELETE', 404, 'NOT_FOUND')
    }
    await error('/personas/missing', 'PATCH', 404, 'NOT_FOUND', {})
    await error('/personas/missing', 'DELETE', 404, 'NOT_FOUND')
    for (const resource of ['presets', 'personas'])
      await error(`/${resource}/missing/default`, 'POST', 404, 'NOT_FOUND')
    for (const resource of ['presets', 'characters']) {
      await error(`/${resource}/missing/duplicate`, 'POST', 404, 'NOT_FOUND')
      await error(`/${resource}/missing/export`, 'GET', 404, 'NOT_FOUND')
    }
    await error('/lorebooks/missing/export', 'GET', 404, 'NOT_FOUND')
    await error('/lorebooks/missing/entries', 'POST', 404, 'NOT_FOUND', {})
    await error('/lorebooks/missing/entries/reorder', 'POST', 404, 'NOT_FOUND', { ids: [] })
    await error('/lorebooks/entries/missing', 'PATCH', 404, 'NOT_FOUND', {})
    await error('/lorebooks/entries/missing', 'DELETE', 404, 'NOT_FOUND')
    for (const resource of ['presets', 'personas', 'characters', 'lorebooks', 'groups']) {
      await error(`/${resource}`, 'POST', 400, 'VALIDATION', { name: '' })
      await error(`/${resource}/missing`, 'PATCH', 400, 'VALIDATION', { name: 3 })
    }
    await error('/characters/missing/export?format=zip', 'GET', 400, 'VALIDATION')
    await error('/lorebooks/settings', 'PUT', 400, 'VALIDATION', { scanDepth: -1 })
    await error('/lorebooks/entries/missing', 'PATCH', 400, 'VALIDATION', { probability: -1 })
    await error('/personas', 'POST', 404, 'NOT_FOUND', { name: '坏关联', lorebookId: 'missing' })
    await error('/personas', 'POST', 404, 'NOT_FOUND', { name: '空关联', lorebookId: '' })
    await error('/characters', 'POST', 404, 'NOT_FOUND', { name: '坏关联', lorebookIds: ['missing'] })
    await error('/characters', 'POST', 404, 'NOT_FOUND', { name: '坏关联', defaultPersonaId: 'missing' })
    for (const [resource, code] of [
      ['presets', 'BAD_PRESET'],
      ['characters', 'BAD_CARD'],
      ['lorebooks', 'BAD_LOREBOOK'],
    ]) {
      const response = await upload(`/${resource}/import`, encode([]), '坏文件.json')
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(code!)
      const missingFile = await app.request(`/api/${resource}/import`, { method: 'POST', body: new FormData() })
      expect(missingFile.status).toBe(400)
    }
    const persona = (await json<PersonaDTO[]>('/personas'))[0]!
    const invalidImage = await upload(`/personas/${persona.id}/avatar`, encode({}), '坏图片.png')
    expect(invalidImage.status).toBe(400)
    expect(((await invalidImage.json()) as { error: { code: string } }).error.code).toBe('BAD_IMAGE')
    for (const resource of ['personas', 'characters']) {
      expect((await upload(`/${resource}/missing/avatar`, png, '头像.png')).status).toBe(404)
    }
    await error('/personas/missing/avatar', 'DELETE', 404, 'NOT_FOUND')
  })
})

// 本地化让底层校验也读取语言设置；隔离模块单例，避免其他测试提前加载数据库。
if (!process.env.CRUD_TEST_CHILD) {
  test('后端 CRUD 接口使用独立数据库进程', async () => {
    const child = Bun.spawn([process.execPath, 'test', 'apps/server/test/crud.test.ts'], {
      env: { ...process.env, CRUD_TEST_CHILD: '1' },
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
  })
}
