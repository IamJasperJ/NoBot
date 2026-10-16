import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HttpError } from '../errors'
import { readUpload } from '../lib/files'
import { saveAttachment } from '../services/attachments'

export const attachmentRoutes = new Hono().post(
  '/',
  // multipart 自身也有开销，文件的精确大小由 readUpload 再检查。
  bodyLimit({
    maxSize: 11 * 1024 * 1024,
    onError: () => {
      throw new HttpError(400, 'TOO_LARGE', '文件太大（上限 10MB）')
    },
  }),
  async (c) => c.json(await saveAttachment(await readUpload(await c.req.parseBody(), 'file', 10))),
)
