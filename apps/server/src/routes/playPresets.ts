import { playPresetInput } from '@ai-parter/shared'
import { Hono } from 'hono'
import { readUpload } from '../lib/files'
import { validate } from '../lib/validate'
import * as service from '../services/playPresets'

export const playPresetRoutes = new Hono()
  .get('/', (c) => c.json(service.listPlayPresets()))
  .post('/', validate('json', playPresetInput), (c) => c.json(service.createPlayPreset(c.req.valid('json'))))
  .post('/import', async (c) => {
    const body = await c.req.parseBody()
    const bytes = await readUpload(body)
    return c.json(service.importJson(bytes))
  })
  .get('/:id/export', async (c) => {
    const file = await service.exportJson(c.req.param('id'))
    c.header('Content-Type', file.contentType)
    c.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    )
    return c.body(new Uint8Array(file.bytes))
  })
  .get('/:id', (c) => c.json(service.getPlayPreset(c.req.param('id'))))
  .patch('/:id', validate('json', playPresetInput.partial()), async (c) =>
    c.json(service.updatePlayPreset(c.req.param('id'), await c.req.json<Record<string, unknown>>())),
  )
  .delete('/:id', (c) => {
    service.deletePlayPreset(c.req.param('id'))
    return c.json({ ok: true })
  })
  .post('/:id/default', (c) => {
    service.setDefaultPlayPreset(c.req.param('id'))
    return c.json({ ok: true })
  })
  .post('/:id/duplicate', (c) => c.json(service.duplicatePlayPreset(c.req.param('id'))))
