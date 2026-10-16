import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../lib/validate'
import { clearLogs, getLog, listLogs } from '../services/logs'

/** 请求日志：错误查看、查看某条消息当时发送的 Prompt */
export const logRoutes = new Hono()
  .get(
    '/',
    validate('query', z.object({ chatId: z.string().optional(), limit: z.coerce.number().int().min(1).optional() })),
    (c) => c.json(listLogs(c.req.valid('query'))),
  )
  .get('/:id', (c) => c.json(getLog(c.req.param('id'))))
  .delete('/', (c) => {
    clearLogs()
    return c.json({ ok: true })
  })
