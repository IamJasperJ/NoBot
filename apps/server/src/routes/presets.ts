import { promptPresetInput } from '@nobot/shared'
import { Hono } from 'hono'
import { readUpload } from '../lib/files'
import { validate } from '../lib/validate'
import * as service from '../services/promptPresets'

export const presetRoutes = new Hono()
  .get('/', (c) => c.json(service.listPromptPresets()))
  .post('/', validate('json', promptPresetInput), (c) => c.json(service.createPromptPreset(c.req.valid('json'))))
  .post('/import', async (c) => {
    const body = await c.req.parseBody()
    const bytes = await readUpload(body)
    return c.json(service.importPromptPreset(bytes, (body.file as File).name))
  })
  .get('/:id/export', async (c) => {
    const file = await service.exportPromptPreset(c.req.param('id'))
    c.header('Content-Type', file.contentType)
    c.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    )
    return c.body(new Uint8Array(file.bytes))
  })
  .get('/:id', (c) => c.json(service.getPromptPreset(c.req.param('id'))))
  .patch('/:id', validate('json', promptPresetInput.partial()), async (c) =>
    c.json(service.updatePromptPreset(c.req.param('id'), await c.req.json<Record<string, unknown>>())),
  )
  .delete('/:id', (c) => {
    service.deletePromptPreset(c.req.param('id'))
    return c.json({ ok: true })
  })
  .post('/:id/default', (c) => {
    service.setDefaultPromptPreset(c.req.param('id'))
    return c.json({ ok: true })
  })
  .post('/:id/duplicate', (c) => c.json(service.duplicatePromptPreset(c.req.param('id'))))
