import { editMessageInput } from '@nobot/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../lib/validate'
import * as chats from '../services/chats'
import { checkWritable, findHostedRoom } from '../services/rooms'
import { readableMessage } from '../services/rooms/dto'
import { editRoomMessage } from '../services/rooms/turns'
import { currentUser } from '../user-context'

/** 普通会话支持删除子树；房间消息通过房间服务编辑和撤回。 */
export const messageRoutes = new Hono()
  .patch('/:id/meta', validate('json', z.strictObject({ imageIndex: z.number().int().min(0) })), (c) => {
    const id = c.req.param('id')
    const room = findHostedRoom(chats.loadMessage(id).chatId)
    if (room) checkWritable(room, currentUser().id)
    return c.json(readableMessage(chats.updateMessageImageIndex(id, c.req.valid('json').imageIndex)))
  })
  .patch(
    '/:id',
    validate(
      'json',
      editMessageInput.extend({ content: z.string().max(100000), reasoning: z.string().max(100000).optional() }),
    ),
    (c) => {
      const id = c.req.param('id')
      const room = findHostedRoom(chats.loadMessage(id).chatId)
      const { content, reasoning } = c.req.valid('json')
      return c.json(
        room
          ? editRoomMessage(room.id, id, content, reasoning)
          : readableMessage(chats.editMessage(id, content, reasoning)),
      )
    },
  )
  .delete('/:id', (c) => {
    const id = c.req.param('id')
    const room = findHostedRoom(chats.loadMessage(id).chatId)
    if (room) editRoomMessage(room.id, id, null)
    else chats.deleteMessage(id)
    return c.json({ ok: true })
  })
