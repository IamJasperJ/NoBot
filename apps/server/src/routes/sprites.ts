import { updateSpriteInput } from '@ai-parter/shared'
import { Hono } from 'hono'
import { HttpError } from '../errors'
import { readUpload } from '../lib/files'
import { validate } from '../lib/validate'
import * as service from '../services/sprites'

export const spriteRoutes = new Hono()
  .get('/', (c) => c.json(service.listSprites(c.req.param('id')!)))
  .post('/', async (c) => {
    const body = await c.req.parseBody({ all: true })
    const fields = updateSpriteInput.parse({ outfit: body.outfit, expression: body.expression })
    const files = Array.isArray(body.files) ? body.files : [body.files]
    if (!files.length || files.some((file) => !(file instanceof File)))
      throw new HttpError(400, 'BAD_REQUEST', '请上传立绘文件')
    const entries = []
    for (const file of files as File[]) {
      if (file.size > 20 * 1024 * 1024) throw new HttpError(400, 'TOO_LARGE', '单张立绘不能超过 20 MB')
      entries.push({ path: file.name, data: new Uint8Array(await file.arrayBuffer()) })
    }
    return c.json(await service.importSprites(c.req.param('id')!, entries, fields))
  })
  .post('/import', async (c) =>
    c.json(await service.importSpriteZip(c.req.param('id')!, await readUpload(await c.req.parseBody(), 'file', 300))),
  )
  .patch('/:spriteId', validate('json', updateSpriteInput), (c) =>
    c.json(service.updateSprite(c.req.param('id')!, c.req.param('spriteId'), c.req.valid('json'))),
  )
  .delete('/:spriteId', async (c) => {
    await service.deleteSprite(c.req.param('id')!, c.req.param('spriteId'))
    return c.json({ ok: true })
  })
  .delete('/', async (c) => {
    const outfit = c.req.query('outfit')
    if (outfit === undefined) throw new HttpError(400, 'BAD_REQUEST', '请指定要删除的服装')
    return c.json(await service.deleteOutfit(c.req.param('id')!, outfit))
  })
