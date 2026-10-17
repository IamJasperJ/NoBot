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
import { t } from '../i18n'
import { matchBackground } from '../services/background-match'
import {
  backgroundsForChat,
  deleteBackground,
  getBackgroundSettings,
  importBackgroundUrl,
  listBackgrounds,
  saveBackground,
  setBackgroundSettings,
  updateBackground,
} from '../services/backgrounds'
import { updateChat } from '../services/chats'
import { quietPrompt } from '../services/quiet-prompt'

const tooLarge = () => new HttpError(413, 'TOO_LARGE', t('文件太大（视频上限 100MB，图片上限 20MB）'))

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
  .post('/auto', zValidator('json', autoBackgroundInput), async (c) => {
    const { chatId } = c.req.valid('json')
    const list = backgroundsForChat(chatId)
    if (!list.length) throw new HttpError(400, 'EMPTY_BACKGROUNDS', t('背景库是空的'))
    const reply = await quietPrompt({
      chatId,
      instruction: `Ignore previous format requirements. Select the location from the following list that best fits the current scene. Output only its exact name from the list, with no other text:\n${list.map((b) => `- ${b.name}：${b.description}`).join('\n')}`,
    })
    const background = matchBackground(list, reply)
    if (!background) throw new HttpError(400, 'EMPTY_REPLY', t('模型没有选择背景'))
    updateChat(chatId, { backgroundId: background.id })
    return c.json({ background, reply })
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
