import { extensionCatalogSourcesInput, extensionInstallConfirmInput, extensionInstallInput } from '@ai-parter/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { extensionAsset, listExtensions, loadLocalExtensions, updateExtension } from '../extensions/registry'
import { validate } from '../lib/validate'
import { catalogSources, extensionCatalog, setCatalogSources } from '../services/extension-catalog'
import {
  cancelInstall,
  checkExtensionUpdate,
  confirmInstall,
  extensionBranches,
  extensionOperation,
  gitStatus,
  previewExtension,
  switchExtension,
  uninstallExtension,
  updateGitExtension,
} from '../services/extension-git'
import { listToolInfo } from '../tools'

/** 扩展管理与工具列表 */
export const extensionRoutes = new Hono()
  .get('/', (c) => c.json(listExtensions()))
  .get('/git', async (c) => c.json(await gitStatus()))
  .get('/catalog/sources', (c) => c.json(catalogSources()))
  .put('/catalog/sources', validate('json', extensionCatalogSourcesInput), (c) =>
    c.json(setCatalogSources(c.req.valid('json').urls)),
  )
  .get('/catalog', async (c) => c.json(await extensionCatalog(c.req.query('refresh') === '1')))
  .post('/install/preview', validate('json', extensionInstallInput), async (c) =>
    c.json(await extensionOperation(() => previewExtension(c.req.valid('json')))),
  )
  .post('/install/confirm', validate('json', extensionInstallConfirmInput), async (c) =>
    c.json(
      await extensionOperation(() => {
        const { token, enable } = c.req.valid('json')
        return confirmInstall(token, enable)
      }),
    ),
  )
  .post('/install/cancel', validate('json', z.object({ token: z.string().min(1) })), async (c) => {
    await extensionOperation(() => cancelInstall(c.req.valid('json').token))
    return c.json({ ok: true })
  })
  .post('/reload', async (c) => c.json(await extensionOperation(loadLocalExtensions)))
  .post('/:id/check-update', async (c) =>
    c.json(await extensionOperation(() => checkExtensionUpdate(c.req.param('id')))),
  )
  .post('/:id/update', async (c) => c.json(await extensionOperation(() => updateGitExtension(c.req.param('id')))))
  .get('/:id/branches', async (c) => c.json(await extensionOperation(() => extensionBranches(c.req.param('id')))))
  .post('/:id/switch', validate('json', z.object({ ref: z.string().min(1) })), async (c) =>
    c.json(await extensionOperation(() => switchExtension(c.req.param('id'), c.req.valid('json').ref))),
  )
  .delete('/:id', async (c) => {
    await extensionOperation(() => uninstallExtension(c.req.param('id')))
    return c.json({ ok: true })
  })
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
      z.object({
        enabled: z.boolean().optional(),
        approvePermissions: z.boolean().optional(),
        settings: z.record(z.string(), z.unknown()).optional(),
      }),
    ),
    (c) => c.json(updateExtension(c.req.param('id'), c.req.valid('json'))),
  )
