import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { HttpError } from '../errors'
import { captionUpload } from '../extensions/registry'
import { t } from '../i18n'
import { readUpload } from '../lib/files'
import { validate } from '../lib/validate'
import { saveAttachment, setAttachmentCg } from '../services/attachments'

export const attachmentRoutes = new Hono().post(
  '/',
  // multipart 自身也有开销，文件的精确大小由 readUpload 再检查。
  bodyLimit({
    maxSize: 11 * 1024 * 1024,
    onError: () => {
      throw new HttpError(400, 'TOO_LARGE', t('文件太大（上限 10MB）'))
    },
  }),
  async (c) => {
    const body = await c.req.parseBody()
    const attachment = await saveAttachment(await readUpload(body, 'file', 10))
    const chatId = typeof body.chatId === 'string' && body.chatId ? body.chatId : undefined
    return c.json((await captionUpload(attachment.id, chatId)) ?? attachment)
  },
)

attachmentRoutes.patch('/:id', validate('json', z.object({ isCg: z.boolean() })), async (c) =>
  c.json(await setAttachmentCg(c.req.param('id'), c.req.valid('json').isCg)),
)
