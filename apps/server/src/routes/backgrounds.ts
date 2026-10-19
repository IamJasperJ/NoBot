import { zValidator } from '@hono/zod-validator'
import {
  autoBackgroundInput,
  backgroundFolderInput,
  backgroundFolderItemsInput,
  backgroundSettingsInput,
  batchDeleteBackgroundsInput,
  importBackgroundUrlInput,
  updateBackgroundInput,
} from '@nobot/shared'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HttpError } from '../errors'
import { t } from '../i18n'
import { autoSelectBackground } from '../services/auto-background'
import {
  batchDeleteBackgrounds,
  changeBackgroundFolderItems,
  createBackgroundFolder,
  deleteBackground,
  deleteBackgroundFolder,
  getBackgroundSettings,
  importBackgroundUrl,
  listBackgroundFolders,
  listBackgrounds,
  saveBackground,
  setBackgroundSettings,
  updateBackground,
  updateBackgroundFolder,
} from '../services/backgrounds'

const tooLarge = () => new HttpError(413, 'TOO_LARGE', t('文件太大（视频上限 100MB，图片上限 20MB）'))

export const backgroundRoutes = new Hono()
  .get('/', (c) => c.json(listBackgrounds(c.req.query('folderId'))))
  .post(
    '/',
    bodyLimit({
      maxSize: 101 * 1024 * 1024,
      onError: () => {
        throw tooLarge()
      },
    }),
    async (c) => {
      const body = await c.req.parseBody()
      const file = body.file
      if (!(file instanceof File)) throw new HttpError(400, 'BAD_REQUEST', t('请选择背景文件'))
      const name = typeof body.name === 'string' ? body.name : file.name.replace(/\.[^.]+$/, '')
      const parsed = updateBackgroundInput.safeParse({ name })
      if (!parsed.success || !parsed.data.name) throw new HttpError(400, 'BAD_REQUEST', t('背景名称不能为空'))
      return c.json(
        await saveBackground(new Uint8Array(await file.arrayBuffer()), { name: parsed.data.name, source: 'upload' }),
      )
    },
  )
  .post('/import-url', zValidator('json', importBackgroundUrlInput), async (c) =>
    c.json(await importBackgroundUrl(c.req.valid('json'))),
  )
  .post('/auto', zValidator('json', autoBackgroundInput), async (c) =>
    c.json(await autoSelectBackground(c.req.valid('json').chatId)),
  )
  .get('/folders', (c) => c.json(listBackgroundFolders()))
  .post('/folders', zValidator('json', backgroundFolderInput), (c) =>
    c.json(createBackgroundFolder(c.req.valid('json'))),
  )
  .patch('/folders/:id', zValidator('json', backgroundFolderInput.partial()), async (c) =>
    c.json(updateBackgroundFolder(c.req.param('id'), await c.req.json())),
  )
  .delete('/folders/:id', (c) => {
    deleteBackgroundFolder(c.req.param('id'))
    return c.json({ ok: true })
  })
  .post('/folders/add', zValidator('json', backgroundFolderItemsInput), (c) => {
    changeBackgroundFolderItems(c.req.valid('json'))
    return c.json({ ok: true })
  })
  .post('/folders/remove', zValidator('json', backgroundFolderItemsInput), (c) => {
    changeBackgroundFolderItems(c.req.valid('json'), true)
    return c.json({ ok: true })
  })
  .post('/batch-delete', zValidator('json', batchDeleteBackgroundsInput), async (c) => {
    await batchDeleteBackgrounds(c.req.valid('json'))
    return c.json({ ok: true })
  })
  .get('/settings', (c) => c.json(getBackgroundSettings()))
  .put('/settings', zValidator('json', backgroundSettingsInput), (c) =>
    c.json(setBackgroundSettings(c.req.valid('json'))),
  )
  .patch('/:id', zValidator('json', updateBackgroundInput), (c) =>
    c.json(updateBackground(c.req.param('id'), c.req.valid('json'))),
  )
  .delete('/:id', async (c) => {
    await deleteBackground(c.req.param('id'))
    return c.json({ ok: true })
  })
