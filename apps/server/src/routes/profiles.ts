import { profileInput } from '@ai-parter/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../lib/validate'
import * as profiles from '../services/profiles'

export const profileRoutes = new Hono()
  .get('/', (c) => c.json(profiles.listProfiles()))
  .post('/', validate('json', profileInput), (c) => c.json(profiles.saveProfile(c.req.valid('json'))))
  .put('/default', validate('json', z.object({ id: z.string().nullable() })), (c) => {
    profiles.setDefaultProfile(c.req.valid('json').id)
    return c.json({ ok: true })
  })
  .put('/:id', validate('json', profileInput), (c) =>
    c.json(profiles.saveProfile(c.req.valid('json'), c.req.param('id'))),
  )
  .delete('/:id', (c) => {
    profiles.deleteProfile(c.req.param('id'))
    return c.json({ ok: true })
  })
