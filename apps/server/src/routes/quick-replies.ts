import { quickReplySetInput } from '@ai-parter/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../lib/validate'
import * as service from '../services/quick-replies'

export const quickReplyRoutes = new Hono()
  .get('/', (c) => c.json(service.getQuickReplies()))
  .post('/', validate('json', quickReplySetInput), (c) => c.json(service.saveQuickReply(c.req.valid('json'))))
  .put('/global', validate('json', z.object({ setIds: z.array(z.string()) })), (c) =>
    c.json(service.setGlobalQuickReplies(c.req.valid('json').setIds)),
  )
  .put('/:id', validate('json', quickReplySetInput), (c) =>
    c.json(service.saveQuickReply(c.req.valid('json'), c.req.param('id'))),
  )
  .delete('/:id', (c) => {
    service.deleteQuickReply(c.req.param('id'))
    return c.json({ ok: true })
  })
