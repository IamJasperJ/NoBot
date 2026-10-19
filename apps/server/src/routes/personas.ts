import { personaInput, personaUpdateInput } from '@nobot/shared'
import { Hono } from 'hono'
import { readUpload } from '../lib/files'
import { validate } from '../lib/validate'
import * as service from '../services/personas'

export const personaRoutes = new Hono()
  .get('/', (c) => c.json(service.listPersonas()))
  .post('/', validate('json', personaInput), (c) => c.json(service.createPersona(c.req.valid('json'))))
  .patch('/:id', validate('json', personaUpdateInput), async (c) =>
    c.json(service.updatePersona(c.req.param('id'), await c.req.json<Record<string, unknown>>())),
  )
  .delete('/:id', async (c) => {
    await service.deletePersona(c.req.param('id'))
    return c.json({ ok: true })
  })
  .post('/:id/default', (c) => {
    service.setDefaultPersona(c.req.param('id'))
    return c.json({ ok: true })
  })
  .post('/:id/avatar', async (c) =>
    c.json(await service.setPersonaAvatar(c.req.param('id'), await readUpload(await c.req.parseBody()))),
  )
  .delete('/:id/avatar', async (c) => c.json(await service.removePersonaAvatar(c.req.param('id'))))
