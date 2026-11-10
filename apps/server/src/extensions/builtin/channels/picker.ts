import { randomBytes } from 'node:crypto'
import { type ChannelActorDTO, type ChannelBindingDTO, channelBindingInput, createRoomInput } from '@nobot/shared'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { db, newId } from '../../../db/client'
import { channelActions, channelRequests, characters, chats, groupMembers, groups, messages } from '../../../db/schema'
import { systemDatabase } from '../../../db/system-client'
import { roomMembers, rooms, users } from '../../../db/system-schema'
import { t } from '../../../i18n'
import { getChatRow } from '../../../services/chats'
import { resolvePersona } from '../../../services/personas'
import { createRoom, requireRole } from '../../../services/rooms'
import { currentUser } from '../../../user-context'
import { OneBotClient } from './adapters/onebot11/client'
import { PluginChannelClient } from './adapters/plugin'
import { actorPersonaId } from './personas'
import { asChannelActor } from './rooms'
import type { ChannelService, MessageEvent } from './service'
import { refused } from './service'
import { accountRow, listBindings } from './store'

export class ChannelPicker {
  constructor(private readonly service: ChannelService) {}
  private pickerItems(accountId: string, kind: 'char' | 'group' | 'all', query = '') {
    const allowlist = accountRow(accountId).config.characterAllowlist
    const charactersList = db
      .select()
      .from(characters)
      .where(isNull(characters.deletedAt))
      .all()
      .filter((item) => !allowlist.length || allowlist.includes(item.id))
      .map((item) => ({ id: item.id, name: item.name, kind: 'char' as const }))
    // 群组也不能间接暴露白名单以外的角色。
    const groupsList = db
      .select()
      .from(groups)
      .where(isNull(groups.deletedAt))
      .all()
      .filter(
        (item) =>
          !allowlist.length ||
          db
            .select()
            .from(groupMembers)
            .where(eq(groupMembers.groupId, item.id))
            .all()
            .every((member) => allowlist.includes(member.characterId)),
      )
      .map((item) => ({ id: item.id, name: item.name, kind: 'group' as const }))
    return [...(kind === 'group' ? [] : charactersList), ...(kind === 'char' ? [] : groupsList)]
      .filter((item) => !query || item.id === query || item.name.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }

  pickerPermission(accountId: string, actor: ChannelActorDTO, event: MessageEvent, binding?: ChannelBindingDTO) {
    if (actor.role === 'blocked' || (binding && binding.state !== 'active')) throw refused()
    const owner = actor.role === 'owner' && actor.linkedUserId === currentUser().id
    if (!owner && listBindings(accountId).some((item) => item.source === 'account-shared' && item.state === 'active'))
      throw refused()
    if (
      db
        .select()
        .from(channelRequests)
        .where(
          and(
            eq(channelRequests.accountId, accountId),
            eq(channelRequests.chat, String(event.chat.id)),
            eq(channelRequests.state, 'blocked'),
          ),
        )
        .get()
    )
      throw refused()
    if (binding?.roomId) asChannelActor(binding, actor, () => requireRole(binding.roomId!, ['owner', 'gm']))
    else if (!owner && (binding || event.chat.type !== 'private' || actor.role !== 'player')) throw refused()
  }

  /** 菜单携带位置而非绑定快照，点击时重新校验绑定，防止旧菜单覆盖后续切换。 */
  private async chatMenu(
    accountId: string,
    actor: ChannelActorDTO,
    event: MessageEvent,
    binding: ChannelBindingDTO | undefined,
    text: string,
    items: { text: string; action: string; args: Record<string, unknown> }[],
  ) {
    const client = this.service.runtime.accounts.get(accountId)?.client
    if (!client) return
    for (const old of db.select().from(channelActions).all()) {
      const original = old.args.event as MessageEvent | undefined
      if (
        ['chat', 'chat-enter', 'chat-list', 'picker'].includes(old.action) &&
        old.allowedActor === actor.externalId &&
        old.args.accountId === accountId &&
        original?.chat.id === event.chat.id &&
        original?.message_thread_id === event.message_thread_id
      )
        db.delete(channelActions).where(eq(channelActions.token, old.token)).run()
    }
    const rows = items.map((item, index) => {
      const token = randomBytes(18).toString('base64url')
      db.insert(channelActions)
        .values({
          token,
          bindingId: binding?.id ?? null,
          action: item.action,
          args: { accountId, event: { ...event, text: '', command: null }, number: index + 1, ...item.args },
          revision: 0,
          allowedActor: actor.externalId,
          expiresAt: Date.now() + 600000,
        })
        .run()
      return [{ text: item.text, callback_data: token }]
    })
    if (client instanceof OneBotClient || client instanceof PluginChannelClient)
      return this.service.send(
        accountId,
        String(event.chat.id),
        `${text}\n${t('回复数字选择')}\n${items.map((item, i) => `${i + 1}. ${item.text}`).join('\n')}`,
        String(event.message_thread_id ?? ''),
      )
    await client.call('sendMessage', {
      chat_id: String(event.chat.id),
      message_thread_id: event.message_thread_id,
      text,
      reply_markup: { inline_keyboard: rows },
    })
  }

  async showChats(
    accountId: string,
    actor: ChannelActorDTO,
    event: MessageEvent,
    binding?: ChannelBindingDTO,
    page = 0,
  ) {
    const all = db.select().from(chats).orderBy(desc(chats.updatedAt)).all()
    const currentIndex = all.findIndex((chat) => chat.id === binding?.chatId)
    if (currentIndex > 0) all.unshift(...all.splice(currentIndex, 1))
    const current = Math.max(
      0,
      Math.min(Number.isFinite(page) ? Math.floor(page) : 0, Math.max(0, Math.ceil(all.length / 8) - 1)),
    )
    const items = all.slice(current * 8, current * 8 + 8).map((chat) => ({
      text: `${chat.id === binding?.chatId ? '✅ ' : ''}${systemDatabase().select().from(rooms).where(eq(rooms.chatId, chat.id)).get() ? '👥 ' : ''}${chat.title}`,
      action: 'chat',
      args: { chatId: chat.id } as Record<string, unknown>,
    }))
    if (current > 0) items.push({ text: `◀ ${t('上一页')}`, action: 'chat-list', args: { page: current - 1 } })
    if ((current + 1) * 8 < all.length)
      items.push({ text: `▶ ${t('下一页')}`, action: 'chat-list', args: { page: current + 1 } })
    items.push({ text: t('新对话'), action: 'chat-list', args: { newChat: true } })
    return this.chatMenu(accountId, actor, event, binding, t('选择会话'), items)
  }

  private takeoverMembers(chatId: string, roomId: string, actor: ChannelActorDTO) {
    const authors = new Set(
      db
        .select()
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .all()
        .map((message) => message.meta.author?.userId),
    )
    return systemDatabase()
      .select({ member: roomMembers, user: users })
      .from(roomMembers)
      .innerJoin(users, eq(users.id, roomMembers.userId))
      .where(eq(roomMembers.roomId, roomId))
      .all()
      .filter(
        ({ member, user }) =>
          authors.has(user.id) &&
          user.id !== (actor.linkedUserId ?? actor.externalUserId) &&
          !user.disabled &&
          member.state === 'active' &&
          member.role !== 'spectator',
      )
  }

  async enterChat(
    accountId: string,
    actor: ChannelActorDTO,
    event: MessageEvent,
    binding: ChannelBindingDTO | undefined,
    chatId: string,
    userId?: string | null,
    confirmed = false,
  ) {
    const chat = getChatRow(chatId)
    if (binding?.chatId === chatId)
      return this.service.send(
        accountId,
        String(event.chat.id),
        t('已切换到：{title}', { title: chat.title }),
        String(event.message_thread_id ?? ''),
      )
    const room = systemDatabase().select().from(rooms).where(eq(rooms.chatId, chatId)).get()
    // 会话没单独选人设时用的是默认人设，按实际生效的人设判断和展示
    const chatPersona = resolvePersona(chat.personaId)
    const appeared = room
      ? db
          .select()
          .from(messages)
          .where(eq(messages.chatId, chatId))
          .all()
          .some((message) => message.meta.author?.userId === (actor.linkedUserId ?? actor.externalUserId))
      : !!chatPersona.id && chatPersona.id === actorPersonaId(binding ?? { accountId, personaMode: null }, actor)
    if (!appeared && !confirmed) {
      const items: { text: string; action: string; args: Record<string, unknown> }[] = [
        { text: t('以渠道人设进入'), action: 'chat-enter', args: { chatId } },
      ]
      if (room) {
        for (const { member, user } of this.takeoverMembers(chatId, room.id, actor))
          items.push({
            text: t('接管：{name}', { name: member.personaName || user.name }),
            action: 'chat-enter',
            args: { chatId, userId: user.id },
          })
      } else
        items.push({
          text: t('接管人设：{name}', { name: chatPersona.name }),
          action: 'chat-enter',
          args: { chatId, userId: null },
        })
      return this.chatMenu(accountId, actor, event, binding, t('你还没有在这个会话里出现过，选择进入方式'), items)
    }
    if (userId !== undefined) {
      if (room ? !this.takeoverMembers(chatId, room.id, actor).some(({ user }) => user.id === userId) : userId !== null)
        throw refused()
    }
    const takeover = userId === undefined ? null : { chatId, userId }
    if (binding) this.service.saveBinding({ ...binding, chatId, roomId: room?.id ?? null, takeover })
    else {
      if (event.chat.type !== 'private') throw refused()
      this.service.saveBinding({
        ...channelBindingInput.parse({
          accountId,
          chatId,
          roomId: room?.id ?? null,
          chat: String(event.chat.id),
          source: 'attached',
          scope: 'private',
          isolation: 'dm',
          trigger: 'all',
          state: 'active',
          takeover,
        }),
        id: newId(),
        createdBy: currentUser().id,
        lastActivityAt: Date.now(),
        idleWarnedAt: null,
      })
    }
    return this.service.send(
      accountId,
      String(event.chat.id),
      t('已切换到：{title}', { title: chat.title }),
      String(event.message_thread_id ?? ''),
    )
  }

  async showPicker(
    accountId: string,
    actor: ChannelActorDTO,
    event: MessageEvent,
    binding?: ChannelBindingDTO,
    kind: 'char' | 'group' | 'all' = 'all',
    query = '',
    page = 0,
  ) {
    this.pickerPermission(accountId, actor, event, binding)
    const items = this.pickerItems(accountId, kind, query)
    if (!items.length)
      return this.service.send(
        accountId,
        String(event.chat.id),
        t('没有匹配的角色或群组'),
        String(event.message_thread_id ?? ''),
      )
    const client = this.service.runtime.accounts.get(accountId)?.client
    if (!client) return
    // 同一请求者和位置只保留最新菜单，避免 QQ 数字回复命中旧菜单。
    for (const action of db.select().from(channelActions).where(eq(channelActions.action, 'picker')).all()) {
      if (
        action.args.accountId === accountId &&
        action.allowedActor === actor.externalId &&
        (action.args.event as MessageEvent).chat.id === event.chat.id &&
        (action.args.event as MessageEvent).message_thread_id === event.message_thread_id
      )
        db.delete(channelActions).where(eq(channelActions.token, action.token)).run()
    }
    const onebot = client instanceof OneBotClient || client instanceof PluginChannelClient
    const current = Math.max(0, Math.min(page, Math.ceil(items.length / 8) - 1))
    const visible = onebot ? items : items.slice(current * 8, current * 8 + 8)
    const token = (extra: Record<string, unknown>) => {
      const value = randomBytes(12).toString('base64url')
      db.insert(channelActions)
        .values({
          token: value,
          bindingId: binding?.id ?? null,
          action: 'picker',
          // 菜单只保存定位信息；原消息不进入待处理队列，选中后提示重发。
          args: {
            accountId,
            event: {
              type: 'message',
              dedupeKey: event.dedupeKey,
              from: event.from,
              chat: event.chat,
              message_id: event.message_id,
              message_thread_id: event.message_thread_id,
              displayName: event.displayName,
              text: '',
              entities: [],
              command: null,
              mentionsBot: false,
              repliesToBot: false,
              unsupportedMedia: false,
            } satisfies MessageEvent,
            kind,
            query,
            ...extra,
          },
          revision: 0,
          allowedActor: actor.externalId,
          expiresAt: Date.now() + 600000,
        })
        .run()
      return value
    }
    const rows = visible.map((item, index) => [
      {
        text: `${item.kind === 'group' ? '👥 ' : ''}${item.name}`,
        callback_data: token({ targetId: item.id, targetKind: item.kind, number: index + 1 }),
      },
    ])
    const navigation = []
    if (!onebot && current > 0) navigation.push({ text: '◀', callback_data: token({ page: current - 1 }) })
    if (!onebot && (current + 1) * 8 < items.length)
      navigation.push({ text: '▶', callback_data: token({ page: current + 1 }) })
    if (navigation.length) rows.push(navigation)
    if (onebot)
      return this.service.send(
        accountId,
        String(event.chat.id),
        `${t('选择角色或群组，回复数字或 /char N')}\n${rows.map((row, i) => `${i + 1}. ${row[0]!.text}`).join('\n')}`,
        String(event.message_thread_id ?? ''),
      )
    await client.call('sendMessage', {
      chat_id: String(event.chat.id),
      message_thread_id: event.message_thread_id,
      text: t('选择角色或群组'),
      reply_markup: { inline_keyboard: rows },
    })
  }

  async selectPicker(
    accountId: string,
    actor: ChannelActorDTO,
    event: MessageEvent,
    kind: 'char' | 'group',
    targetId: string,
    binding?: ChannelBindingDTO,
  ) {
    this.pickerPermission(accountId, actor, event, binding)
    const config = accountRow(accountId).config
    if (config.characterMode !== 'generic' || !this.pickerItems(accountId, kind).some((item) => item.id === targetId))
      throw refused()
    if (!binding) {
      const created = await this.service.resolveBinding(accountId, event, actor, { kind, id: targetId })
      if (!created) return
    } else {
      const chat = this.service.createChannelChat(
        config.provider,
        kind === 'group' ? { groupId: targetId } : { characterId: targetId },
      )
      const room = binding.roomId ? createRoom(createRoomInput.parse({ name: chat.title, chatId: chat.id })) : null
      this.service.saveBinding({ ...binding, chatId: chat.id, roomId: room?.id ?? null })
    }
    await this.service.send(
      accountId,
      String(event.chat.id),
      t('已选择，请重新发送消息'),
      String(event.message_thread_id ?? ''),
    )
  }

  async pickerCommand(accountId: string, actor: ChannelActorDTO, event: MessageEvent, binding?: ChannelBindingDTO) {
    const config = accountRow(accountId).config
    if (config.characterMode === 'fixed') {
      const name = config.characterId
        ? this.service.host.getCharacter(config.characterId).name
        : (db
            .select()
            .from(groups)
            .where(eq(groups.id, config.groupId ?? ''))
            .get()?.name ?? config.name)
      return this.service.send(
        accountId,
        String(event.chat.id),
        t('此机器人始终扮演 {name}', { name }),
        String(event.message_thread_id ?? ''),
      )
    }
    const kind = event.command?.name === 'group' ? 'group' : 'char'
    const query = event.command?.args.trim() ?? ''
    this.pickerPermission(accountId, actor, event, binding)
    const items = this.pickerItems(accountId, kind, query)
    const exact = items.find((item) => item.id === query)
    if (query && (exact || items.length === 1)) {
      const item = exact ?? items[0]!
      return this.selectPicker(accountId, actor, event, item.kind, item.id, binding)
    }
    return this.showPicker(accountId, actor, event, binding, kind === 'char' && !query ? 'all' : kind, query)
  }
}
