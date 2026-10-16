import { Hono } from 'hono'
import { z } from 'zod'
import { extensionAsset, listExtensions, updateExtension } from '../extensions/registry'
import { validate } from '../lib/validate'
import { listToolInfo } from '../tools'

/** 扩展管理与工具列表 */
export const extensionRoutes = new Hono()
  .get('/', (c) => c.json(listExtensions()))
  .get('/tools', (c) => c.json(listToolInfo()))
  .get(
    '/:id/client.js',
    async (c) =>
      new Response(await extensionAsset(c.req.param('id'), 'client'), {
        headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' },
      }),
  )
  .get(
    '/:id/style.css',
    async (c) =>
      new Response(await extensionAsset(c.req.param('id'), 'style'), {
        headers: { 'Content-Type': 'text/css', 'Cache-Control': 'no-cache' },
      }),
  )
  .patch(
    '/:id',
    validate(
      'json',
      z.object({ enabled: z.boolean().optional(), settings: z.record(z.string(), z.unknown()).optional() }),
    ),
    (c) => c.json(updateExtension(c.req.param('id'), c.req.valid('json'))),
  )
