import { editMessageInput } from '@ai-parter/shared'
import { Hono } from 'hono'
import { validate } from '../lib/validate'
import * as chats from '../services/chats'

/** 编辑、删除消息（删除会连同后面的整棵子树） */
export const messageRoutes = new Hono()
  .patch('/:id', validate('json', editMessageInput), (c) =>
    c.json(chats.editMessage(c.req.param('id'), c.req.valid('json').content)),
  )
  .delete('/:id', (c) => {
    chats.deleteMessage(c.req.param('id'))
    return c.json({ ok: true })
  })
