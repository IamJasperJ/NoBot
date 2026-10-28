import {
  createRoomInput,
  roomCharacterProposalInput,
  roomInitiativeInput,
  roomInviteInput,
  roomJoinInput,
  roomPersonaInput,
  roomRollInput,
  roomSendInput,
  roomSessionInput,
  roomWhisperInput,
  updateRoomInput,
} from '@nobot/shared'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { systemDatabase } from '../db/system-client'
import { roomBans, roomInvites, roomMembers } from '../db/system-schema'
import { t } from '../i18n'
import { validate } from '../lib/validate'
import * as rooms from '../services/rooms'
import * as roomCharacters from '../services/rooms/characters'
import * as extensions from '../services/rooms/extensions'
import { roomEditInput } from '../services/rooms/input'
import { lobbyAsset } from '../services/rooms/lobby'
import { dispatchScope } from '../services/rooms/scope'
import * as transfer from '../services/rooms/transfer'
import * as trpg from '../services/rooms/trpg'
import * as turns from '../services/rooms/turns'
import { currentUser } from '../user-context'

const ok = { ok: true }
export const roomRoutes = new Hono()
  .use('*', async (c, next) => {
    c.header('Cache-Control', 'private, no-store')
    await next()
  })
  .get('/', (c) => c.json(rooms.listRooms()))
  .post('/', validate('json', createRoomInput), (c) => c.json(rooms.createRoom(c.req.valid('json'))))
  .get('/lobby/assets/:kind/:file', (c) =>
    lobbyAsset(c.req.query('invite') ?? '', c.req.param('kind'), c.req.param('file'), c.req.raw),
  )
  .get('/lobby', (c) => c.json(rooms.lobby(c.req.query('invite') ?? '')))
  .post('/join', validate('json', roomJoinInput), (c) => c.json(rooms.joinRoom(c.req.valid('json'))))
  .get('/:id', (c) => c.json(rooms.roomDetail(c.req.param('id'))))
  .patch('/:id', validate('json', updateRoomInput), (c) =>
    c.json(rooms.updateRoom(c.req.param('id'), c.req.valid('json'))),
  )
  .delete('/:id', (c) => {
    rooms.deleteRoom(c.req.param('id'))
    return c.json(ok)
  })
  .get('/:id/usage', (c) => c.json(rooms.usage(c.req.param('id'))))
  .post(
    '/:id/invites',
    validate(
      'json',
      roomInviteInput.superRefine((input, ctx) => {
        if (input.kind === 'direct' && !input.targetUserId?.trim())
          ctx.addIssue({ code: 'custom', path: ['targetUserId'], message: t('直接邀请必须指定目标用户') })
      }),
    ),
    (c) => c.json(rooms.createInvite(c.req.param('id'), c.req.valid('json'))),
  )
  .get('/:id/invites', (c) => {
    rooms.requireRole(c.req.param('id'), ['owner', 'gm'])
    return c.json(
      systemDatabase()
        .select()
        .from(roomInvites)
        .where(eq(roomInvites.roomId, c.req.param('id')))
        .all()
        .map(({ tokenHash: _, ...dto }) => ({ ...dto, status: rooms.inviteStatus(dto) })),
    )
  })
  .delete('/:id/invites/:inviteId', (c) => {
    rooms.requireRole(c.req.param('id'), ['owner', 'gm'])
    systemDatabase()
      .update(roomInvites)
      .set({ revokedAt: Date.now() })
      .where(and(eq(roomInvites.roomId, c.req.param('id')), eq(roomInvites.id, c.req.param('inviteId'))))
      .run()
    return c.json(ok)
  })
  .post('/:id/read', validate('json', z.object({ seq: z.number().int().min(0) })), (c) => {
    extensions.markRead(c.req.param('id'), c.req.valid('json').seq)
    return c.json(ok)
  })
  .post('/:id/leave', (c) => {
    rooms.removeMember(c.req.param('id'), currentUser().id, 'left')
    return c.json(ok)
  })
  .post('/:id/members/:userId/kick', (c) => {
    rooms.removeMember(c.req.param('id'), c.req.param('userId'), 'kicked')
    return c.json(ok)
  })
  .post('/:id/members/:userId/ban', (c) => {
    rooms.removeMember(c.req.param('id'), c.req.param('userId'), 'banned')
    return c.json(ok)
  })
  .delete('/:id/bans/:userId', (c) => {
    rooms.requireRole(c.req.param('id'), ['owner'])
    systemDatabase()
      .delete(roomBans)
      .where(and(eq(roomBans.roomId, c.req.param('id')), eq(roomBans.userId, c.req.param('userId'))))
      .run()
    return c.json(ok)
  })
  .patch(
    '/:id/members/:userId/role',
    validate('json', z.object({ role: z.enum(['player', 'gm', 'spectator']) })),
    (c) => {
      const { room } = rooms.requireRole(c.req.param('id'), ['owner'])
      const target = rooms.membership(room.id, c.req.param('userId')).member
      if (
        target.role === 'owner' ||
        (target.role === 'spectator' &&
          c.req.valid('json').role !== 'spectator' &&
          rooms.members(room.id).filter((m) => m.role !== 'spectator').length >= room.maxMembers)
      )
        throw rooms.refused()
      if (
        c.req.valid('json').role === 'spectator' &&
        (!room.allowSpectators ||
          (target.role !== 'spectator' &&
            rooms.members(room.id).filter((m) => m.role === 'spectator').length >= room.maxSpectators))
      )
        throw rooms.refused()
      rooms.directoryChange(
        room,
        currentUser().id,
        'room.member',
        { action: 'role', userId: target.userId, role: c.req.valid('json').role },
        () => {
          systemDatabase()
            .update(roomMembers)
            .set({ role: c.req.valid('json').role })
            .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, target.userId)))
            .run()
        },
      )
      return c.json(rooms.roomDetail(room.id))
    },
  )
  .put('/:id/persona', validate('json', roomPersonaInput), (c) =>
    c.json(rooms.updatePersona(c.req.param('id'), c.req.valid('json'))),
  )
  .post('/:id/accept-rules', validate('json', z.object({ rulesVersion: z.number().int() })), (c) =>
    c.json(rooms.acceptRules(c.req.param('id'), c.req.valid('json').rulesVersion)),
  )
  .post('/:id/messages', validate('json', roomSendInput), (c) =>
    c.json(turns.sendRoomMessage(c.req.param('id'), c.req.valid('json'))),
  )
  .patch('/:id/messages/:messageId', validate('json', roomEditInput), (c) =>
    c.json(turns.editRoomMessage(c.req.param('id'), c.req.param('messageId'), c.req.valid('json').content)),
  )
  .delete('/:id/messages/:messageId', (c) =>
    c.json(turns.editRoomMessage(c.req.param('id'), c.req.param('messageId'), null)),
  )
  .post('/:id/messages/:messageId/suggest', (c) => {
    turns.suggest(c.req.param('id'), c.req.param('messageId'))
    return c.json(ok)
  })
  .post('/:id/turn', (c) => c.json(turns.triggerTurn(c.req.param('id'))))
  .post('/:id/turn/request', (c) => {
    turns.requestTurn(c.req.param('id'))
    return c.json(ok)
  })
  .post('/:id/abort', (c) => {
    turns.abortTurn(c.req.param('id'))
    return c.json(ok)
  })
  .post('/:id/typing', (c) => {
    turns.typing(c.req.param('id'))
    return c.json(ok)
  })
  .post('/:id/roll', validate('json', roomRollInput), (c) =>
    c.json(trpg.rollRoom(c.req.param('id'), c.req.valid('json'))),
  )
  .post('/:id/whispers', validate('json', roomWhisperInput), (c) =>
    c.json(trpg.whisperRoom(c.req.param('id'), c.req.valid('json'))),
  )
  .post('/:id/round/ready', validate('json', z.object({ state: z.enum(['done', 'passed', 'pending']) })), (c) =>
    c.json(trpg.readyRoom(c.req.param('id'), c.req.valid('json').state)),
  )
  .post('/:id/round/skip', validate('json', z.object({ userId: z.string() })), (c) =>
    c.json(trpg.skipRound(c.req.param('id'), c.req.valid('json').userId)),
  )
  .post('/:id/round/next', (c) => c.json(trpg.advanceRound(c.req.param('id'))))
  .get('/:id/initiative', (c) => {
    const { room } = rooms.membership(c.req.param('id'))
    return c.json(rooms.asHost(room, () => trpg.initiativeSnapshot(room)))
  })
  .put('/:id/initiative', validate('json', roomInitiativeInput), (c) =>
    c.json(trpg.setInitiative(c.req.param('id'), c.req.valid('json'))),
  )
  .post('/:id/initiative/skip', (c) => c.json(trpg.skipInitiative(c.req.param('id'))))
  .get('/:id/choices/:messageId', (c) => c.json(trpg.choiceSnapshot(c.req.param('id'), c.req.param('messageId'))))
  .post('/:id/choices/:messageId/vote', validate('json', z.object({ index: z.number().int().min(0) })), (c) =>
    c.json(trpg.pickRoomChoice(c.req.param('id'), c.req.param('messageId'), c.req.valid('json').index)),
  )
  .post(
    '/:id/choices/:messageId/close',
    validate('json', z.object({ winner: z.number().int().min(0).optional() })),
    (c) => c.json(trpg.closeChoice(c.req.param('id'), c.req.param('messageId'), c.req.valid('json').winner)),
  )
  .get('/:id/unread', (c) => c.json(extensions.unreadDetails(c.req.param('id'))))
  .put('/:id/notify', validate('json', z.object({ preference: z.enum(['all', 'mentions', 'none']) })), (c) =>
    c.json(extensions.setNotify(c.req.param('id'), c.req.valid('json').preference)),
  )
  .get(
    '/:id/export',
    validate('query', z.object({ format: z.enum(['markdown', 'json']).default('markdown') })),
    (c) => {
      const format = c.req.valid('query').format
      c.header('Content-Type', format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8')
      c.header(
        'Content-Disposition',
        `attachment; filename="room-${encodeURIComponent(c.req.param('id'))}.${format === 'json' ? 'json' : 'md'}"`,
      )
      return c.body(extensions.exportRoom(c.req.param('id'), format))
    },
  )
  .get('/:id/characters/proposals', (c) => c.json(roomCharacters.listProposals(c.req.param('id'))))
  .post('/:id/characters/proposals', validate('json', roomCharacterProposalInput), (c) =>
    c.json(roomCharacters.proposeCharacter(c.req.param('id'), c.req.valid('json'))),
  )
  .get('/:id/characters/proposals/:proposalId', (c) =>
    c.json(roomCharacters.getProposal(c.req.param('id'), c.req.param('proposalId'))),
  )
  .post('/:id/characters/proposals/:proposalId/approve', (c) =>
    c.json(roomCharacters.decideProposal(c.req.param('id'), c.req.param('proposalId'), true)),
  )
  .post('/:id/characters/proposals/:proposalId/reject', (c) =>
    c.json(roomCharacters.decideProposal(c.req.param('id'), c.req.param('proposalId'), false)),
  )
  .delete('/:id/characters/:copyId', (c) => {
    roomCharacters.withdrawCharacter(c.req.param('id'), c.req.param('copyId'))
    return c.json(ok)
  })
  .get('/:id/sessions', (c) => c.json(extensions.listSessions(c.req.param('id'))))
  .post('/:id/sessions', validate('json', roomSessionInput), (c) =>
    c.json(extensions.saveSession(c.req.param('id'), c.req.valid('json'))),
  )
  .put('/:id/sessions/:sessionId', validate('json', roomSessionInput), (c) =>
    c.json(extensions.saveSession(c.req.param('id'), c.req.valid('json'), c.req.param('sessionId'))),
  )
  .delete('/:id/sessions/:sessionId', (c) => {
    extensions.cancelSession(c.req.param('id'), c.req.param('sessionId'))
    return c.json(ok)
  })
  .put(
    '/:id/sessions/:sessionId/rsvp',
    validate('json', z.object({ response: z.enum(['yes', 'maybe', 'no']) })),
    (c) => {
      extensions.rsvp(c.req.param('id'), c.req.param('sessionId'), c.req.valid('json').response)
      return c.json(ok)
    },
  )
  .get('/:id/transfer', (c) => c.json(transfer.getTransfer(c.req.param('id'))))
  .post('/:id/transfer', validate('json', z.object({ userId: z.string().min(1) })), (c) =>
    c.json(transfer.transferOffer(c.req.param('id'), c.req.valid('json').userId)),
  )
  .post('/:id/transfer/accept', (c) => c.json(transfer.acceptTransfer(c.req.param('id'))))
  .post('/:id/transfer/decline', (c) => {
    transfer.declineTransfer(c.req.param('id'))
    return c.json(ok)
  })
  .all('/:id/scope/*', (c) =>
    dispatchScope(
      c.req.param('id'),
      c.req.raw,
      c.req.path.split('/scope/')[1] ? `/${c.req.path.split('/scope/')[1]}` : '/',
    ),
  )
