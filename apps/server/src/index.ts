import { bootstrap } from './bootstrap'
import { env } from './env'
import { createServer } from './server'

await bootstrap()
const server = createServer()

Bun.serve({
  port: env.port,
  hostname: env.host,
  fetch: server.fetch,
  // 默认 10 秒无数据就断开连接，模型思考时间长会被误断，调到最大值
  idleTimeout: 255,
})

console.log(`NoBot 后端已启动：http://${env.host}:${env.port}`)
