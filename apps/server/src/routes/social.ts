import {
  blockUserInput,
  friendRequestInput,
  notificationCursor,
  notificationPageInput,
  notificationReadInput,
  presenceInput,
} from '@nobot/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { validate } from '../lib/validate'
import * as social from '../services/social'
import { presence } from '../services/social/presence'
import { currentUser } from '../user-context'

export const socialRoutes = new Hono()
  .get('/users/lookup', validate('query', friendRequestInput), (c) =>
    c.json(social.findUserByHandle(c.req.valid('query').handle, currentUser().id)),
  )
  .get('/friends', (c) => c.json(social.listFriends(currentUser().id)))
  .post('/friends/requests', validate('json', friendRequestInput), (c) => {
    social.requestFriend(currentUser().id, c.req.valid('json').handle)
    return c.json({ ok: true })
  })
  .delete('/friends/:userId', (c) => {
    social.removeFriend(currentUser().id, c.req.param('userId'))
    return c.json({ ok: true })
  })
  .get('/blocks', (c) => c.json(social.listBlocks(currentUser().id)))
  .post('/blocks', validate('json', blockUserInput), (c) => {
    social.blockUser(currentUser().id, c.req.valid('json').userId)
    return c.json({ ok: true })
  })
  .delete('/blocks/:userId', (c) => {
    social.unblockUser(currentUser().id, c.req.param('userId'))
    return c.json({ ok: true })
  })
  .get('/notifications', validate('query', notificationPageInput), (c) => {
    const { before, limit } = c.req.valid('query')
    return c.json(social.listNotifications(currentUser().id, before, limit))
  })
  .get('/notifications/unread-count', (c) => c.json({ unreadCount: social.unreadCount(currentUser().id) }))
  .post('/notifications/read', validate('json', notificationReadInput), (c) => {
    social.readNotifications(currentUser().id, c.req.valid('json').ids)
    return c.json({ ok: true })
  })
  .post('/notifications/:id/dismiss', validate('param', z.object({ id: notificationCursor })), (c) => {
    social.dismissNotification(currentUser().id, c.req.valid('param').id)
    return c.json({ ok: true })
  })
  .put('/presence', validate('json', presenceInput), (c) => {
    presence.setPreference(currentUser().id, c.req.valid('json').status)
    return c.json({ ok: true })
  })

for (const action of ['accept', 'reject', 'cancel'] as const)
  socialRoutes.post(`/friends/requests/:id/${action}`, (c) => {
    social.respondFriend(currentUser().id, c.req.param('id'), action)
    return c.json({ ok: true })
  })
