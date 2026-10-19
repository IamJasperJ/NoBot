import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 运行时配置，都可以用环境变量覆盖。
 * HOST 默认只监听本机；想让局域网里的手机访问，设 HOST=0.0.0.0。
 * 注意：开放到局域网后，同一网络里的任何人都能用你的 API Key 调模型。
 */
const root = resolve(import.meta.dir, '../../..')

export const env = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '127.0.0.1',
  isProd: process.env.NODE_ENV === 'production',
  dataDir: resolve(process.env.DATA_DIR ?? join(root, 'data')),
  webDist: join(root, 'apps/web/dist'),
  migrationsDir: join(import.meta.dir, '../drizzle'),
}

export const paths = {
  db: join(env.dataDir, 'app.db'),
  sprites: join(env.dataDir, 'assets/sprites'),
  avatars: join(env.dataDir, 'assets/avatars'),
  audio: join(env.dataDir, 'assets/audio'),
  backgrounds: join(env.dataDir, 'assets/backgrounds'),
  attachments: join(env.dataDir, 'assets/attachments'),
}

mkdirSync(paths.avatars, { recursive: true })
mkdirSync(paths.attachments, { recursive: true })

mkdirSync(paths.backgrounds, { recursive: true })

mkdirSync(paths.sprites, { recursive: true })

mkdirSync(paths.audio, { recursive: true })
