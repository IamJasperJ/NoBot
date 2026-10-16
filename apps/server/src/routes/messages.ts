import { editMessageInput } from '@ai-parter/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../lib/validate'
import * as chats from '../services/chats'

/** 编辑、删除消息（删除会连同后面的整棵子树） */
export const messageRoutes = new Hono()
  .patch('/:id/meta', validate('json', z.strictObject({ imageIndex: z.number().int().min(0) })), (c) =>
    c.json(chats.updateMessageImageIndex(c.req.param('id'), c.req.valid('json').imageIndex)),
  )
  .patch('/:id', validate('json', editMessageInput), (c) =>
    c.json(chats.editMessage(c.req.param('id'), c.req.valid('json').content)),
  )
  .delete('/:id', (c) => {
    chats.deleteMessage(c.req.param('id'))
    return c.json({ ok: true })
  })
