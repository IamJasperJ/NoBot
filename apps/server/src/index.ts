import { join } from 'node:path'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { app as api } from './app'
import { bootstrap } from './bootstrap'
import { env } from './env'

await bootstrap()

const server = new Hono()
server.route('/', api)

// 生产模式下由后端直接提供前端页面，只需要启动一个进程
if (env.isProd) server.use('/*', serveStatic({ root: env.webDist }))

server.notFound((c) => {
  // 接口路径不存在：返回和其他错误一样的 JSON
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: { code: 'NOT_FOUND', message: `接口不存在：${c.req.method} ${c.req.path}` } }, 404)
  }
  // 其他路径交给前端处理，统一返回 index.html
  if (env.isProd) return c.html(Bun.file(join(env.webDist, 'index.html')).text())
  return c.text('Not Found', 404)
})

Bun.serve({
  port: env.port,
  hostname: env.host,
  fetch: server.fetch,
  // 默认 10 秒无数据就断开连接，模型思考时间长会被误断，调到最大值
  idleTimeout: 255,
})

console.log(`AI-Parter 后端已启动：http://${env.host}:${env.port}`)
