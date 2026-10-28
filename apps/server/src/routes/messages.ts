import { editMessageInput } from '@nobot/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../lib/validate'
import * as chats from '../services/chats'
import { readableMessage } from '../services/rooms/dto'
import { rateLimitMessage, roomEditInput } from '../services/rooms/input'
import { currentUser } from '../user-context'

/** 编辑、删除消息（删除会连同后面的整棵子树） */
export const messageRoutes = new Hono()
  .patch('/:id/meta', validate('json', z.strictObject({ imageIndex: z.number().int().min(0) })), (c) =>
    c.json(readableMessage(chats.updateMessageImageIndex(c.req.param('id'), c.req.valid('json').imageIndex))),
  )
  .patch(
    '/:id',
    validate(
      'json',
      editMessageInput.extend({ content: roomEditInput.shape.content, reasoning: z.string().max(100000).optional() }),
    ),
    (c) => {
      rateLimitMessage(`message:${currentUser().id}`)
      return c.json(
        readableMessage(
          chats.editMessage(c.req.param('id'), c.req.valid('json').content, c.req.valid('json').reasoning),
        ),
      )
    },
  )
  .delete('/:id', (c) => {
    chats.deleteMessage(c.req.param('id'))
    return c.json({ ok: true })
  })
