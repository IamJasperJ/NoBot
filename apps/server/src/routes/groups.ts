import { groupInput } from '@ai-parter/shared'
import { Hono } from 'hono'
import { validate } from '../lib/validate'
import * as service from '../services/groups'

export const groupRoutes = new Hono()
  .get('/', (c) => c.json(service.listGroups()))
  .post('/', validate('json', groupInput), (c) => c.json(service.createGroup(c.req.valid('json'))))
  .get('/:id', (c) => c.json(service.getGroup(c.req.param('id'))))
  .patch('/:id', validate('json', groupInput.partial()), async (c) =>
    c.json(service.updateGroup(c.req.param('id'), await c.req.json<Record<string, unknown>>())),
  )
  .delete('/:id', (c) => {
    service.deleteGroup(c.req.param('id'))
    return c.json({ ok: true })
  })
