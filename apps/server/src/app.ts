import { Hono } from 'hono'
import { z } from 'zod'
import { HttpError } from './errors'
import { forwardExtension } from './extensions/registry'
import { t } from './i18n'
import { validationMessage } from './lib/validate'
import { appSettingsRoutes } from './routes/app-settings'
import { assetRoutes } from './routes/assets'
import { attachmentRoutes } from './routes/attachments'
import { backgroundRoutes } from './routes/backgrounds'
import { bookmarkRoutes } from './routes/bookmarks'
import { characterRoutes } from './routes/characters'
import { chatRoutes } from './routes/chats'
import { connectionRoutes } from './routes/connections'
import { extensionRoutes } from './routes/extensions'
import { groupRoutes } from './routes/groups'
import { liveRoutes } from './routes/live'
import { logRoutes } from './routes/logs'
import { lorebookRoutes } from './routes/lorebooks'
import { messageRoutes } from './routes/messages'
import { personaRoutes } from './routes/personas'
import { playPresetRoutes } from './routes/playPresets'
import { presetRoutes } from './routes/presets'
import { profileRoutes } from './routes/profiles'
import { quickReplyRoutes } from './routes/quick-replies'
import { roomRoutes } from './routes/rooms'
import { socialRoutes } from './routes/social'
import { trashRoutes } from './routes/trash'
import { logError } from './services/logs'

/**
 * 所有 /api 路由。每个资源一个路由文件（routes/），路由只做参数校验和调用 service，
 * 业务逻辑都在 services/ 里。
 *
 * 接口一览（请求 / 返回的类型都在 packages/shared 里）：
 *   /connections      连接配置（地址、Key、模型）
 *   /presets          生成预设（采样参数、Prompt 管理器）
 *   /personas         用户人设
 *   /characters       角色（含导入导出、头像）
 *   /lorebooks        世界书与条目、全局激活设置（/lorebooks/settings）
 *   /groups           群组
 *   /chats            会话、生成、代写、预览、分支
 *   /messages         编辑、删除消息
 *   /logs             请求日志
 *   /extensions       扩展与工具
 *   /assets           头像等静态文件
 */

// 校验错误提示用中文
z.config(z.locales.zhCN())

export const app = new Hono().basePath('/api')

app.onError((err, c) => {
  if (err instanceof z.ZodError)
    return c.json({ error: { code: 'VALIDATION', message: validationMessage(err.issues) } }, 400)
  if (err instanceof HttpError)
    return c.json({ error: { code: err.code, message: err.message, ...err.details } }, err.status)
  console.error(err)
  logError(`${c.req.method} ${c.req.path}`, err)
  return c.json({ error: { code: 'INTERNAL', message: t('服务器内部错误') } }, 500)
})

app.get('/health', (c) => c.json({ ok: true }))

app.route('/backgrounds', backgroundRoutes)
app.route('/connections', connectionRoutes)
app.route('/profiles', profileRoutes)
app.route('/quick-replies', quickReplyRoutes)
app.route('/presets', presetRoutes)
app.route('/play-presets', playPresetRoutes)
app.route('/personas', personaRoutes)
app.route('/characters', characterRoutes)
app.route('/lorebooks', lorebookRoutes)
app.route('/groups', groupRoutes)
app.route('/chats', chatRoutes)
app.route('/trash', trashRoutes)
app.route('/bookmarks', bookmarkRoutes)
app.route('/messages', messageRoutes)
app.route('/logs', logRoutes)
app.route('/app-settings', appSettingsRoutes)
app.route('/extensions', extensionRoutes)
app.route('/assets', assetRoutes).route('/attachments', attachmentRoutes)

app.all('/ext/:id/*', (c) => forwardExtension(c.req.param('id'), c.req.raw))

app.route('/social', socialRoutes)
app.route('/live', liveRoutes)

app.route('/rooms', roomRoutes)
