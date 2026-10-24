import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../../../db/client'
import { channelActors } from '../../../db/schema'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { validate } from '../../../lib/validate'
import { OneBotClient } from './adapters/onebot11/client'
import { oneTimeStageUrl } from './miniapp'
import type { ChannelRuntime } from './runtime'
import { bindingRow } from './store'

export function oneBotRoutes(app: Hono, runtime: () => ChannelRuntime) {
  const client = (id: string) => {
    const value = runtime().accounts.get(id)?.client
    if (!(value instanceof OneBotClient))
      throw new HttpError(409, 'CHANNEL_UNAVAILABLE', t('无法连接机器人平台，请检查网络后重试'))
    return value
  }
  app.get('/accounts/:id/friends', async (c) => c.json(await client(c.req.param('id')).friendList()))
  app.post(
    '/accounts/:id/friends/delete',
    validate('json', z.object({ userId: z.number().int().positive(), confirm: z.literal(true) })),
    async (c) => {
      const api = client(c.req.param('id'))
      if (!api.napcat) throw new HttpError(400, 'UNSUPPORTED', t('此平台不支持该操作'))
      await api.action('delete_friend', { user_id: c.req.valid('json').userId })
      api.invalidateFriends()
      return c.json({ ok: true })
    },
  )
  app.post(
    '/bindings/:id/onebot',
    validate(
      'json',
      z.discriminatedUnion('action', [
        z.object({ action: z.literal('essence'), messageId: z.number().int(), confirm: z.literal(true) }),
        z.object({ action: z.literal('notice'), content: z.string().min(1).max(4500), confirm: z.literal(true) }),
        z.object({ action: z.literal('read'), messageId: z.number().int(), confirm: z.literal(true) }),
      ]),
    ),
    async (c) => {
      const binding = bindingRow(c.req.param('id'))
      const api = client(binding.accountId)
      const input = c.req.valid('json')
      if (!api.napcat) throw new HttpError(400, 'UNSUPPORTED', t('此平台不支持该操作'))
      if (input.action === 'essence' || input.action === 'read') {
        const source = await api.action<{ group_id?: number; user_id?: number }>('get_msg', {
          message_id: input.messageId,
        })
        const expected = binding.scope === 'group' ? String(source.group_id) : String(source.user_id)
        if (expected !== binding.chat.replace(/^-/, '')) throw new HttpError(403, 'FORBIDDEN', t('没有渠道操作权限'))
      }
      if (input.action !== 'read') {
        if (binding.scope !== 'group') throw new HttpError(400, 'INVALID_INPUT', t('渠道设置无效'))
        const member = await api.action<{ role: string }>('get_group_member_info', {
          group_id: Number(binding.chat.replace(/^-/, '')),
          user_id: Number(api.selfId),
          no_cache: true,
        })
        if (!['owner', 'admin'].includes(member.role)) throw new HttpError(403, 'FORBIDDEN', t('机器人缺少群管理权限'))
      }
      if (input.action === 'essence') await api.action('set_essence_msg', { message_id: input.messageId })
      if (input.action === 'notice')
        await api.action('_send_group_notice', {
          group_id: Number(binding.chat.replace(/^-/, '')),
          content: input.content,
        })
      if (input.action === 'read') await api.action('mark_msg_as_read', { message_id: input.messageId })
      return c.json({ ok: true })
    },
  )
  app.post('/bindings/:id/stage-link', validate('json', z.object({ actorId: z.string() })), (c) => {
    const binding = bindingRow(c.req.param('id'))
    client(binding.accountId)
    const actor = db
      .select()
      .from(channelActors)
      .where(eq(channelActors.id, c.req.valid('json').actorId))
      .get()
    if (actor?.provider !== 'onebot11' || !actor.accountIds.includes(binding.accountId))
      throw new HttpError(403, 'FORBIDDEN', t('没有渠道操作权限'))
    const url = oneTimeStageUrl(binding, actor)
    if (!url) throw new HttpError(400, 'MINIAPP_UNAVAILABLE', t('请先设置 HTTPS 公网地址'))
    return c.json({ url, expiresIn: 600 })
  })
}
