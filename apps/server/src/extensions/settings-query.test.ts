import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { draftChatId, parseSettingsDraft } from './types'

test('POST 草稿覆盖保存值，非法请求体回退且会话读取共用请求体', async () => {
  const saved = { backend: 'a', token: 'saved', nested: { one: 1 } }
  const app = new Hono().post('/', async (c) =>
    c.json({
      settings: await parseSettingsDraft(c, saved),
      chatId: await draftChatId(c),
    }),
  )
  const response = await app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: { backend: 'b', nested: { two: 2 } }, chatId: 'chat' }),
  })
  expect(await response.json()).toEqual({
    settings: { backend: 'b', token: 'saved', nested: { two: 2 } },
    chatId: 'chat',
  })
  for (const body of ['', 'not-json', '[]', 'null', '1', '"string"', '{}', '{"settings": []}']) {
    const result = await app.request('/', { method: 'POST', body })
    expect(await result.json()).toEqual({ settings: saved })
  }
  expect(saved.backend).toBe('a')
})
