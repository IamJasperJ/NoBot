import {
  autoBackgroundInput,
  backgroundSettingsInput,
  importBackgroundUrlInput,
  updateBackgroundInput,
} from '@ai-parter/shared'
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HttpError } from '../errors'
import { matchBackground } from '../services/background-match'
import {
  deleteBackground,
  getBackgroundSettings,
  importBackgroundUrl,
  listBackgrounds,
  renameBackground,
  saveBackground,
  setBackgroundSettings,
} from '../services/backgrounds'
import { updateChat } from '../services/chats'
import { quietPrompt } from '../services/quiet-prompt'

const tooLarge = () => new HttpError(413, 'TOO_LARGE', '文件太大（视频上限 100MB，图片上限 20MB）')

export const backgroundRoutes = new Hono()
  .get('/', (c) => c.json(listBackgrounds()))
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
      if (!(file instanceof File)) throw new HttpError(400, 'BAD_REQUEST', '请选择背景文件')
      const name = typeof body.name === 'string' ? body.name : file.name.replace(/\.[^.]+$/, '')
      const parsed = updateBackgroundInput.safeParse({ name })
      if (!parsed.success) throw new HttpError(400, 'BAD_REQUEST', '背景名称不能为空')
      return c.json(
        await saveBackground(new Uint8Array(await file.arrayBuffer()), { name: parsed.data.name, source: 'upload' }),
      )
    },
  )
  .post('/import-url', zValidator('json', importBackgroundUrlInput), async (c) =>
    c.json(await importBackgroundUrl(c.req.valid('json'))),
  )
  .post('/auto', zValidator('json', autoBackgroundInput), async (c) => {
    const list = listBackgrounds()
    if (!list.length) throw new HttpError(400, 'EMPTY_BACKGROUNDS', '背景库是空的')
    const { chatId } = c.req.valid('json')
    const reply = await quietPrompt({
      chatId,
      instruction: `忽略之前的格式要求。从下面的列表中选出最适合当前场景的地点，只输出列表里的名字，不要输出其他任何文字：\n${list.map((b) => `- ${b.name}`).join('\n')}`,
    })
    const background = matchBackground(list, reply)
    if (!background) throw new HttpError(400, 'EMPTY_REPLY', '模型没有选择背景')
    updateChat(chatId, { backgroundId: background.id })
    return c.json({ background, reply })
  })
  .get('/settings', (c) => c.json(getBackgroundSettings()))
  .put('/settings', zValidator('json', backgroundSettingsInput), (c) =>
    c.json(setBackgroundSettings(c.req.valid('json'))),
  )
  .patch('/:id', zValidator('json', updateBackgroundInput), (c) =>
    c.json(renameBackground(c.req.param('id'), c.req.valid('json').name)),
  )
  .delete('/:id', async (c) => {
    await deleteBackground(c.req.param('id'))
    return c.json({ ok: true })
  })
