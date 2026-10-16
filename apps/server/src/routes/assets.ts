import { Hono } from 'hono'
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
