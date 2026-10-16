import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { parseSettingsQuery } from './types'

test('候选接口草稿覆盖保存值，非法查询回退且不改变保存值', async () => {
  const saved = { backend: 'a', token: 'saved', nested: { one: 1 } }
  const app = new Hono().get('/', (c) => c.json(parseSettingsQuery(c, saved)))
  const response = await app.request(
    `/?settings=${encodeURIComponent(JSON.stringify({ backend: 'b', nested: { two: 2 } }))}`,
  )
  expect(await response.json()).toEqual({ backend: 'b', token: 'saved', nested: { two: 2 } })
  for (const query of ['', 'not-json', '[]', 'null', '1', '"string"']) {
    expect(await (await app.request(`/?settings=${encodeURIComponent(query)}`)).json()).toEqual(saved)
  }
  expect(saved.backend).toBe('a')
})
