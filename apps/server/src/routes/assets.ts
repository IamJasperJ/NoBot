import { join } from 'node:path'
import { Hono } from 'hono'
import { paths } from '../env'
import { HttpError } from '../errors'
import { readAvatar } from '../lib/files'

/** 头像文件。文件名只允许 ULID + 扩展名，防止 ../ 之类的路径穿越 */
export const assetRoutes = new Hono().get('/avatars/:file', async (c) => {
  const name = c.req.param('file')
  if (!/^[0-9A-Z]{26}\.(png|webp)$/.test(name)) throw new HttpError(400, 'BAD_REQUEST', '文件名不合法')
  const file = readAvatar(name)
  if (!(await file.exists())) throw new HttpError(404, 'NOT_FOUND', '头像不存在')
  // 地址里带了 ?v=更新时间，内容变了地址就变，所以可以长期缓存
  return new Response(file, { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } })
})

assetRoutes.get('/attachments/:file', async (c) => {
  const name = c.req.param('file')
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}\.webp$/.test(name)) throw new HttpError(400, 'BAD_REQUEST', '文件名不合法')
  const file = Bun.file(join(paths.attachments, name))
  if (!(await file.exists())) throw new HttpError(404, 'NOT_FOUND', '图片不存在')
  return new Response(file, {
    headers: {
      'Content-Type': 'image/webp',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
})

assetRoutes.get('/backgrounds/:file', async (c) => {
  const name = c.req.param('file')
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}(?:\.thumb\.webp|\.(?:webp|gif|mp4|webm))$/.test(name))
    throw new HttpError(400, 'BAD_REQUEST', '文件名不合法')
  const file = Bun.file(join(paths.backgrounds, name))
  if (!(await file.exists())) throw new HttpError(404, 'NOT_FOUND', '背景不存在')
  const ext = name.split('.').pop()!
  const mime = { webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm' }[ext]!
  const headers = new Headers({
    'Content-Type': mime,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Length': String(file.size),
  })
  if (mime.startsWith('video/')) {
    headers.set('Accept-Ranges', 'bytes')
    const range = c.req.header('Range')
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      const start = match?.[1] ? Number(match[1]) : Math.max(0, file.size - Number(match?.[2]))
      const end = match?.[1] && match[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1
      if (
        !match ||
        (!match[1] && !match[2]) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= file.size
      ) {
        headers.set('Content-Range', `bytes */${file.size}`)
        headers.set('Content-Length', '0')
        return new Response(null, { status: 416, headers })
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${file.size}`)
      headers.set('Content-Length', String(end - start + 1))
      return new Response(file.slice(start, end + 1), { status: 206, headers })
    }
  }
  return new Response(file, { headers })
})
