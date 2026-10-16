import { apiPresetInput, testConnectionInput } from '@ai-parter/shared'
import { Hono } from 'hono'
import { validate } from '../lib/validate'
import * as connections from '../services/connections'

/** 连接配置：地址、Key、模型 */
export const connectionRoutes = new Hono()
  .get('/', (c) => c.json(connections.listApiPresets()))
  .post('/', validate('json', apiPresetInput), (c) => c.json(connections.createApiPreset(c.req.valid('json'))))
  .post('/test', validate('json', testConnectionInput), async (c) =>
    c.json(await connections.testConnection(c.req.valid('json'))),
  )
  .patch('/:id', validate('json', apiPresetInput), (c) =>
    c.json(connections.updateApiPreset(c.req.param('id'), c.req.valid('json'))),
  )
  .delete('/:id', (c) => {
    connections.deleteApiPreset(c.req.param('id'))
    return c.json({ ok: true })
  })
  .post('/:id/default', (c) => {
    connections.setDefaultApiPreset(c.req.param('id'))
    return c.json({ ok: true })
  })
