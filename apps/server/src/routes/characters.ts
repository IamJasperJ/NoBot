import { characterImportLorebookSchema, characterInput, characterUpdateInput } from '@nobot/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { readUpload } from '../lib/files'
import { validate } from '../lib/validate'
import { characterCgs } from '../services/attachments'
import * as service from '../services/characters'
import { characterUsage } from '../services/trash'
import { spriteRoutes } from './sprites'

export const characterRoutes = new Hono()
  .get('/', (c) => c.json(service.listCharacters()))
  .post('/', validate('json', characterInput), (c) => c.json(service.createCharacter(c.req.valid('json'))))
  .post('/import/preview', async (c) =>
    c.json(service.previewCharacterImport(await readUpload(await c.req.parseBody()))),
  )
  .post(
    '/import',
    validate('query', z.object({ lorebook: characterImportLorebookSchema.default('skip') })),
    async (c) =>
      c.json(await service.importCharacter(await readUpload(await c.req.parseBody()), c.req.valid('query').lorebook)),
  )
  .get('/:id/export', validate('query', z.object({ format: z.enum(['png', 'json']).default('png') })), async (c) => {
    const file = await service.exportCharacter(c.req.param('id'), c.req.valid('query').format)
    c.header('Content-Type', file.contentType)
    c.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    )
    return c.body(new Uint8Array(file.bytes))
  })
  .get('/:id/cgs', (c) => {
    service.getCharacterRow(c.req.param('id'))
    return c.json(characterCgs(c.req.param('id')))
  })
  .get('/:id/usage', (c) => c.json(characterUsage(c.req.param('id'))))
  .get('/:id', (c) => c.json(service.getCharacter(c.req.param('id'))))
  .patch('/:id', validate('json', characterUpdateInput), async (c) =>
    c.json(service.updateCharacter(c.req.param('id'), await c.req.json<Record<string, unknown>>())),
  )
  .delete('/:id', async (c) => {
    await service.deleteCharacter(c.req.param('id'))
    return c.json({ ok: true })
  })
  .post('/:id/duplicate', async (c) => c.json(await service.duplicateCharacter(c.req.param('id'))))
  .post('/:id/avatar', async (c) =>
    c.json(await service.setCharacterAvatar(c.req.param('id'), await readUpload(await c.req.parseBody()))),
  )

characterRoutes.use('/:id/sprites/*', async (c, next) => {
  service.getCharacterRow(c.req.param('id')!)
  await next()
})
characterRoutes.route('/:id/sprites', spriteRoutes)
