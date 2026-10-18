import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import sharp from 'sharp'

test('附件接口校验文件大小、格式、取图路径和持久化尺寸', async () => {
  if (!process.env.ATTACHMENT_TEST_CHILD) {
    const directory = await mkdtemp(join(tmpdir(), 'ai-parter-attachments-'))
    try {
      const child = Bun.spawn([process.execPath, 'test', 'apps/server/test/attachments.test.ts'], {
        env: { ...process.env, DATA_DIR: directory, ATTACHMENT_TEST_CHILD: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, out + err).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    return
  }
  const { initDatabase } = await import('../src/db/client')
  initDatabase()
  const { attachmentRoutes } = await import('../src/routes/attachments')
  const { assetRoutes } = await import('../src/routes/assets')
  const { HttpError } = await import('../src/errors')
  const { getAttachment, resolveImages } = await import('../src/services/attachments')
  const app = new Hono().route('/attachments', attachmentRoutes).route('/assets', assetRoutes)
  app.onError((error, c) =>
    c.json({ error: { message: error.message } }, error instanceof HttpError ? error.status : 500),
  )
  const upload = (bytes: Uint8Array) => {
    const form = new FormData()
    form.append('file', new File([bytes], '图片.png'))
    return app.request('/attachments', { method: 'POST', body: form })
  }
  expect((await app.request('/attachments', { method: 'POST', body: new FormData() })).status).toBe(400)
  expect((await upload(new TextEncoder().encode('这不是图片'))).status).toBe(400)
  expect((await upload(new Uint8Array(10 * 1024 * 1024 + 1))).status).toBe(400)
  expect((await app.request('/assets/attachments/invalid.webp')).status).toBe(400)
  expect((await app.request('/assets/attachments/01ARZ3NDEKTSV4RRFFQ69G5FAV.webp')).status).toBe(404)
  const png = await sharp({ create: { width: 24, height: 12, channels: 3, background: 'blue' } })
    .png()
    .toBuffer()
  const res = await upload(png)
  expect(res.status).toBe(200)
  const image = (await res.json()) as import('@ai-parter/shared').AttachmentDTO
  expect(getAttachment(image.id)).toEqual(image)
  expect(() => getAttachment('../图片')).toThrow()
  const messages = [{ role: 'user' as const, content: '', images: [image.id] }]
  expect(await resolveImages(messages, 512)).toEqual(await resolveImages(messages, 512))
})
