import { updateSpriteInput } from '@nobot/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { HttpError } from '../errors'
import { t } from '../i18n'
import { readUpload } from '../lib/files'
import { validate } from '../lib/validate'
import { spriteJob, startSpriteJob } from '../services/sprite-generation'
import * as service from '../services/sprites'

export const spriteRoutes = new Hono()
  .post('/generate', async (c) => c.json(await startSpriteJob(c.req.param('id')!, await c.req.json())))
  .get('/generate/:jobId', (c) => c.json(spriteJob(c.req.param('id')!, c.req.param('jobId'))))
  .get('/', (c) => c.json(service.listSprites(c.req.param('id')!)))
  .post('/', async (c) => {
    const body = await c.req.parseBody({ all: true })
    const fields = updateSpriteInput.parse({ outfit: body.outfit, expression: body.expression })
    const files = Array.isArray(body.files) ? body.files : [body.files]
    if (!files.length || files.some((file) => !(file instanceof File)))
      throw new HttpError(400, 'BAD_REQUEST', t('请上传立绘文件'))
    const entries = []
    for (const file of files as File[]) {
      if (file.size > 20 * 1024 * 1024) throw new HttpError(400, 'TOO_LARGE', t('单张立绘不能超过 20 MB'))
      entries.push({ path: file.name, data: new Uint8Array(await file.arrayBuffer()) })
    }
    return c.json(await service.importSprites(c.req.param('id')!, entries, fields))
  })
  .post('/import', async (c) => {
    const body = await c.req.parseBody()
    // 根目录下的图片归入界面上当前选中的服装（不传就是默认服装）
    const { outfit } = updateSpriteInput.parse({ outfit: body.outfit ?? '' })
    return c.json(await service.importSpriteZip(c.req.param('id')!, await readUpload(body, 'file', 300), outfit))
  })
  .post('/delete', validate('json', z.object({ ids: z.array(z.string()).min(1).max(500) })), async (c) =>
    c.json(await service.deleteSprites(c.req.param('id')!, c.req.valid('json').ids)),
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
    if (outfit === undefined) throw new HttpError(400, 'BAD_REQUEST', t('请指定要删除的服装'))
    return c.json(await service.deleteOutfit(c.req.param('id')!, outfit))
  })
