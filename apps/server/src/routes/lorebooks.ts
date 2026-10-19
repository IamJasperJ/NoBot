import { lorebookEntryDataSchema, lorebookInput, worldInfoSettingsSchema } from '@nobot/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { readUpload } from '../lib/files'
import { validate } from '../lib/validate'
import * as service from '../services/lorebooks'
import { getWorldInfoSettings, setWorldInfoSettings } from '../services/settings'

export const lorebookRoutes = new Hono()
  .get('/', (c) => c.json(service.listLorebooks()))
  .post('/', validate('json', lorebookInput), (c) => c.json(service.createLorebook(c.req.valid('json'))))
  .get('/settings', (c) => c.json(getWorldInfoSettings()))
  .put('/settings', validate('json', worldInfoSettingsSchema), (c) => c.json(setWorldInfoSettings(c.req.valid('json'))))
  .post('/import', async (c) => {
    const body = await c.req.parseBody()
    const bytes = await readUpload(body)
    return c.json(service.importLorebook(bytes, (body.file as File).name))
  })
  .patch('/entries/:entryId', validate('json', lorebookEntryDataSchema.partial()), async (c) =>
    c.json(service.updateEntry(c.req.param('entryId'), await c.req.json<Record<string, unknown>>())),
  )
  .delete('/entries/:entryId', (c) => {
    service.deleteEntry(c.req.param('entryId'))
    return c.json({ ok: true })
  })
  .get('/:id/export', async (c) => {
    const file = await service.exportLorebook(c.req.param('id'))
    c.header('Content-Type', file.contentType)
    c.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    )
    return c.body(new Uint8Array(file.bytes))
  })
  .get('/:id', (c) => c.json(service.getLorebookWithEntries(c.req.param('id'))))
  .patch('/:id', validate('json', lorebookInput.partial()), async (c) =>
    c.json(service.updateLorebook(c.req.param('id'), await c.req.json<Record<string, unknown>>())),
  )
  .delete('/:id', (c) => {
    service.deleteLorebook(c.req.param('id'))
    return c.json({ ok: true })
  })
  .post('/:id/entries', validate('json', lorebookEntryDataSchema.partial()), (c) =>
    c.json(service.createEntry(c.req.param('id'), c.req.valid('json'))),
  )
  .post('/:id/entries/reorder', validate('json', z.object({ ids: z.array(z.string()) })), (c) => {
    service.reorderEntries(c.req.param('id'), c.req.valid('json').ids)
    return c.json({ ok: true })
  })
