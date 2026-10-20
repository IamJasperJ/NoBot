import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CharacterDTO, ChatDTO, ChatPage, GroupDTO, TrashDTO, UsageDTO } from '@nobot/shared'
import sharp from 'sharp'

let app: typeof import('../src/app').app
let sqlite: typeof import('../src/db/client').sqlite
let directory: string
const previousDataDir = process.env.DATA_DIR

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
async function missing(path: string, method = 'GET', data?: unknown) {
  const response = await request(path, method, data)
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
}

describe.skipIf(!process.env.TRASH_TEST_CHILD)('角色与群组回收站', () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nobot-trash-'))
    process.env.DATA_DIR = directory
    const client = await import('../src/db/client')
    sqlite = client.sqlite
    client.initDatabase()
    const { seedPlayPresets } = await import('../src/services/playPresets.builtin')
    seedPlayPresets()
    app = (await import('../src/app')).app
  })
  afterAll(async () => {
    sqlite?.close()
    if (previousDataDir === undefined) delete process.env.DATA_DIR
    else process.env.DATA_DIR = previousDataDir
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  test('软删除隐藏角色和会话，恢复保留消息，彻底删除级联并清理头像', async () => {
    const actor = await json<CharacterDTO>('/characters', 'POST', { name: '旅人', first_mes: '你好，世界' })
    const png = await sharp({ create: { width: 12, height: 18, channels: 3, background: '#ffccaa' } })
      .png()
      .toBuffer()
    const form = new FormData()
    form.set('file', new File([png], '头像.png'))
    const avatarResponse = await app.request(`/api/characters/${actor.id}/avatar`, { method: 'POST', body: form })
    expect(avatarResponse.status).toBe(200)
    const withAvatar = (await avatarResponse.json()) as CharacterDTO
    const avatarPath = join(directory, 'users/test/assets/avatars', `${actor.id}.webp`)
    const originalPath = join(directory, 'users/test/assets/avatars', `${actor.id}.png`)
    const chat = await json<ChatDTO>('/chats', 'POST', { characterId: actor.id })
    const before = await json<ChatPage>(`/chats/${chat.id}`)
    await json('/chats', 'POST', { characterId: actor.id })
    expect(await json<UsageDTO>(`/characters/${actor.id}/usage`)).toEqual({ chats: 2, groups: [] })

    await json(`/characters/${actor.id}`, 'DELETE')
    expect(await json('/characters')).toEqual([])
    expect(await json(`/chats?characterId=${actor.id}`)).toEqual([])
    expect(await json('/chats')).toEqual([])
    for (const path of [
      `/characters/${actor.id}`,
      `/characters/${actor.id}/usage`,
      `/characters/${actor.id}/export`,
      `/characters/${actor.id}/sprites`,
      `/chats/${chat.id}`,
    ])
      await missing(path)
    await missing('/chats', 'POST', { characterId: actor.id })
    await missing(`/characters/${actor.id}`, 'DELETE')
    const trash = await json<TrashDTO>('/trash')
    expect(trash.items).toHaveLength(1)
    expect(trash.items[0]).toMatchObject({ id: actor.id, kind: 'character', chats: 2, avatarUrl: withAvatar.avatarUrl })
    expect(trash.items[0]!.deletedAt).toBeNumber()
    expect(await Bun.file(avatarPath).exists()).toBe(true)
    expect(await Bun.file(originalPath).exists()).toBe(true)

    await json(`/trash/characters/${actor.id}/restore`, 'POST')
    expect((await json<CharacterDTO[]>('/characters')).map((item) => item.id)).toEqual([actor.id])
    expect(await json<ChatDTO[]>(`/chats?characterId=${actor.id}`)).toHaveLength(2)
    expect((await json<ChatPage>(`/chats/${chat.id}`)).messages).toEqual(before.messages)
    expect((await json<TrashDTO>('/trash')).items).toEqual([])
    await missing(`/trash/characters/${actor.id}`, 'DELETE')
    await missing(`/trash/characters/${actor.id}/restore`, 'POST')

    await json(`/characters/${actor.id}`, 'DELETE')
    await json(`/trash/characters/${actor.id}`, 'DELETE')
    expect(sqlite.query('SELECT id FROM chats WHERE character_id = ?').all(actor.id)).toEqual([])
    expect(sqlite.query('SELECT id FROM messages WHERE chat_id = ?').all(chat.id)).toEqual([])
    expect(await Bun.file(avatarPath).exists()).toBe(false)
    expect(await Bun.file(originalPath).exists()).toBe(false)
    expect((await json<TrashDTO>('/trash')).items).toEqual([])
    await missing(`/trash/characters/${actor.id}/restore`, 'POST')
    await missing(`/trash/characters/${actor.id}`, 'DELETE')
  })

  test('成员暂时隐藏且不改关联，生成跳过，群组恢复后会话完好，usage 排除已删除群组', async () => {
    const a = await json<CharacterDTO>('/characters', 'POST', { name: '甲', first_mes: '甲的开场' })
    const b = await json<CharacterDTO>('/characters', 'POST', { name: '乙', first_mes: '乙的开场' })
    const group = await json<GroupDTO>('/groups', 'POST', {
      name: '探险队',
      members: [{ characterId: a.id }, { characterId: b.id, muted: true }],
    })
    const other = await json<GroupDTO>('/groups', 'POST', { name: '已删除队伍', members: [{ characterId: a.id }] })
    await json(`/groups/${other.id}`, 'DELETE')
    await json('/chats', 'POST', { characterId: a.id })
    const chat = await json<ChatDTO>('/chats', 'POST', { groupId: group.id })
    const before = await json<ChatPage>(`/chats/${chat.id}`)
    expect(await json<UsageDTO>(`/characters/${a.id}/usage`)).toEqual({
      chats: 1,
      groups: [{ id: group.id, name: group.name }],
    })
    expect(await json<UsageDTO>(`/groups/${group.id}/usage`)).toEqual({ chats: 1, groups: [] })
    await json(`/characters/${a.id}`, 'DELETE')
    expect((await json<GroupDTO>(`/groups/${group.id}`)).members.map((m) => m.characterId)).toEqual([b.id])
    expect((await json<ChatPage>(`/chats/${chat.id}`)).group?.members.map((m) => m.characterId)).toEqual([b.id])
    const { loadGenerationContext } = await import('../src/services/context')
    expect(loadGenerationContext(chat.id, { requireConnection: false }).members.map((m) => m.id)).toEqual([b.id])
    expect(sqlite.query('SELECT character_id FROM group_members WHERE group_id = ?').all(group.id)).toHaveLength(2)
    const newChat = await json<ChatDTO>('/chats', 'POST', { groupId: group.id })
    expect((await json<ChatPage>(`/chats/${newChat.id}`)).messages).toEqual([])
    await missing('/groups', 'POST', { name: '不能加入回收站成员', members: [{ characterId: a.id }] })
    await json(`/trash/characters/${a.id}/restore`, 'POST')
    expect((await json<GroupDTO>(`/groups/${group.id}`)).members).toEqual(group.members)
    expect(loadGenerationContext(chat.id, { requireConnection: false }).members.map((m) => m.id)).toEqual([a.id, b.id])

    await json(`/groups/${group.id}`, 'DELETE')
    expect(await json('/groups')).toEqual([])
    expect(await json(`/chats?groupId=${group.id}`)).toEqual([])
    await missing(`/groups/${group.id}`)
    await missing(`/groups/${group.id}/usage`)
    await missing(`/chats/${chat.id}`)
    await missing('/chats', 'POST', { groupId: group.id })
    expect((await json<TrashDTO>('/trash')).items.find((item) => item.id === group.id)).toMatchObject({
      kind: 'group',
      chats: 2,
      avatarUrl: null,
    })
    expect((await json<UsageDTO>(`/characters/${a.id}/usage`)).groups).toEqual([])
    await json(`/trash/groups/${group.id}/restore`, 'POST')
    expect((await json<ChatPage>(`/chats/${chat.id}`)).messages).toEqual(before.messages)
    await missing(`/trash/groups/${group.id}/restore`, 'POST')
    await missing(`/trash/groups/${group.id}`, 'DELETE')
    await json(`/groups/${group.id}`, 'DELETE')
    await json(`/trash/groups/${group.id}`, 'DELETE')
    expect(sqlite.query('SELECT id FROM chats WHERE group_id = ?').all(group.id)).toEqual([])
    expect(sqlite.query('SELECT id FROM messages WHERE chat_id = ?').all(chat.id)).toEqual([])
    expect((await json<CharacterDTO>(`/characters/${a.id}`)).name).toBe('甲')
    await json('/trash', 'DELETE')
    await json(`/characters/${a.id}`, 'DELETE')
    await json(`/characters/${b.id}`, 'DELETE')
    await json('/trash', 'DELETE')
  })

  test('清空仅删除回收站条目、返回数量，按删除时间倒序，非法恢复和彻底删除为 404', async () => {
    const a = await json<CharacterDTO>('/characters', 'POST', { name: '留在列表' })
    const b = await json<CharacterDTO>('/characters', 'POST', { name: '回收站角色' })
    const group = await json<GroupDTO>('/groups', 'POST', { name: '回收站群组', members: [{ characterId: b.id }] })
    for (const [kind, id] of [
      ['characters', a.id],
      ['groups', group.id],
      ['characters', 'missing'],
      ['groups', 'missing'],
    ]) {
      await missing(`/trash/${kind}/${id}/restore`, 'POST')
      await missing(`/trash/${kind}/${id}`, 'DELETE')
    }
    await json(`/characters/${b.id}`, 'DELETE')
    await json(`/groups/${group.id}`, 'DELETE')
    // 固定删除时间，验证跨资源的排序不依赖查询表的顺序。
    sqlite.query('UPDATE characters SET deleted_at = ? WHERE id = ?').run(100, b.id)
    sqlite.query('UPDATE groups SET deleted_at = ? WHERE id = ?').run(200, group.id)
    expect((await json<TrashDTO>('/trash')).items.map((item) => item.id)).toEqual([group.id, b.id])
    expect(await json('/trash', 'DELETE')).toEqual({ deleted: 2 })
    expect(await json('/trash', 'DELETE')).toEqual({ deleted: 0 })
    expect(await json('/trash')).toEqual({ items: [] })
    expect((await json<CharacterDTO[]>('/characters')).map((item) => item.id)).toEqual([a.id])
    await missing(`/trash/groups/${group.id}/restore`, 'POST')
    await missing(`/trash/groups/${group.id}`, 'DELETE')
  })
})

// 数据库单例需要独立进程，避免影响其他套件的临时目录与连接。
if (!process.env.TRASH_TEST_CHILD) {
  test('回收站使用独立数据库进程', async () => {
    const child = Bun.spawn([process.execPath, 'test', 'apps/server/test/trash.test.ts'], {
      env: { ...process.env, TRASH_TEST_CHILD: '1' },
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
