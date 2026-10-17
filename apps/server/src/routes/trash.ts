import { Hono } from 'hono'
import * as service from '../services/trash'

export const trashRoutes = new Hono()
  .get('/', (c) => c.json(service.listTrash()))
  .post('/characters/:id/restore', (c) => {
    service.restoreTrash('character', c.req.param('id'))
    return c.json({ ok: true })
  })
  .post('/groups/:id/restore', (c) => {
    service.restoreTrash('group', c.req.param('id'))
    return c.json({ ok: true })
  })
  .delete('/characters/:id', async (c) => {
    await service.purgeTrash('character', c.req.param('id'))
    return c.json({ ok: true })
  })
  .delete('/groups/:id', async (c) => {
    await service.purgeTrash('group', c.req.param('id'))
    return c.json({ ok: true })
  })
  .delete('/', async (c) => c.json({ deleted: await service.emptyTrash() }))
