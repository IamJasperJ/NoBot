import { createHash, randomBytes, randomInt } from 'node:crypto'
import { parseStageMessage, toDisplayText } from '@nobot/core/stage'
import {
  type ChannelActorDTO,
  type ChannelBindingDTO,
  channelBindingInput,
  createRoomInput,
  type GenerateInput,
  type MessageDTO,
} from '@nobot/shared'
import { and, eq, isNull, lt } from 'drizzle-orm'
import { db, newId } from '../../../db/client'
import {
  channelActions,
  channelActors,
  channelBindingChats,
  channelBindings,
  channelDeliveries,
  channelInbox,
  channelPairings,
  channelRequests,
  chats,
  messages,
} from '../../../db/schema'
import { systemDatabase } from '../../../db/system-client'
import { rooms } from '../../../db/system-schema'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { getChatRow, loadMessage } from '../../../services/chats'
import { getJob } from '../../../services/generation/generation'
import {
  acceptRules,
  createRoom,
  projectRoomEvent,
  removeMember,
  requireRole,
  roomRow,
  subscribeRoomEvents,
} from '../../../services/rooms'
import { roomMessage } from '../../../services/rooms/dto'
import { dispatchScope } from '../../../services/rooms/scope'
import { pickRoomChoice, readyRoom, rollRoom, whisperRoom } from '../../../services/rooms/trpg'
import { abortTurn, editRoomMessage, sendRoomMessage, triggerTurn } from '../../../services/rooms/turns'
import { subscribeSocialNotifications } from '../../../services/social'
import { currentUser, runAsUser } from '../../../user-context'
import type { ExtensionHost, ServerEvent } from '../../types'
import { downloadTelegramFile } from './adapters/telegram/media'
import { decodeTelegram, type TelegramEvent } from './adapters/telegram/receive'
import { escapeHtml, inlineTelegramSegments, renderTelegram, type TelegramSegment } from './adapters/telegram/render'
import { DeferredTelegramStream, type TelegramStream, TelegramTextStream } from './adapters/telegram/stream'
import { receiveManagedBot } from './managed-bots'
import { type MiniAppButton, miniAppButton } from './miniapp'
import { OutboundMedia } from './outbound-media'
import { chooseActorPersona, syncActorPersona } from './personas'
import { checkIdle, groupAdded, markLeft, requestLocation } from './policies'
import { reactToMessage } from './reactions'
import { addChannelMember, asChannelActor } from './rooms'
import { ChannelRuntime } from './runtime'
import { locationKey, matchChannelBinding, resolveChannelSettings } from './settings'
import { accountRow, bindingRow, listBindings, markReceived, recordActorSeen } from './store'

const refused = () => new HttpError(403, 'CHANNEL_REFUSED', t('没有渠道操作权限'))
type MessageEvent = Extract<TelegramEvent, { type: 'message' | 'edit' }>
export class ChannelService {
  readonly runtime: ChannelRuntime
  readonly media: OutboundMedia
  private albums = new Map<
    string,
    { event: MessageEvent; images: string[]; texts: string[]; timer: ReturnType<typeof setTimeout> }
  >()
  private queued = new Map<string, { texts: string[]; images: string[] }>()
  private deliveryTails = new Map<string, Promise<unknown>>()
  private inputTails = new Map<string, Promise<unknown>>()
  private generationSubscriptions = new Map<string, () => void>()
  private streams = new Map<string, { stream: TelegramStream; content: string; reasoning: string }>()
  private editTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private presenceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private rates = new Map<string, number[]>()
  private unlistenNotifications: () => void
  private unlisten: () => void
  private timer: ReturnType<typeof setInterval>
  private idleTimer: ReturnType<typeof setInterval>
  constructor(
    readonly host: ExtensionHost,
    readonly globalSettings: () => Record<string, unknown>,
  ) {
    this.runtime = new ChannelRuntime(host, (id, update) => this.receive(id, update))
    this.media = new OutboundMedia(host, (id, code) => this.runtime.log(id, code))
    const owner = currentUser()
    const ownerId = owner.id
    this.unlistenNotifications = subscribeSocialNotifications((userId, type, payload) => {
      if (!['room.your-turn', 'room.mention'].includes(type) || typeof payload.roomId !== 'string') return
      const roomId = payload.roomId
      const room = systemDatabase().select().from(rooms).where(eq(rooms.id, roomId)).get()
      if (room?.hostUserId !== ownerId) return
      runAsUser(owner, () => {
        const actors = db
          .select()
          .from(channelActors)
          .all()
          .filter((a) => a.role !== 'blocked' && (a.linkedUserId ?? a.externalUserId) === userId)
        for (const binding of listBindings().filter(
          (b) => b.roomId === roomId && b.state === 'active' && b.scope === 'group',
        )) {
          if (!this.settings(binding).values.mentionOnTurn || !actors.length) continue
          const mentions = actors
            .map((a) =>
              a.username
                ? escapeHtml(`@${a.username}`)
                : /^\d+$/.test(a.externalId)
                  ? `<a href="tg://user?id=${a.externalId}">${escapeHtml(a.displayName)}</a>`
                  : escapeHtml(a.displayName),
            )
            .join(' ')
          const client = this.runtime.accounts.get(binding.accountId)?.client
          if (client)
            void client
              .serialized(binding.chat, () =>
                client.call('sendMessage', {
                  chat_id: binding.chat,
                  message_thread_id: binding.thread || undefined,
                  text: `${mentions} ${escapeHtml(type === 'room.your-turn' ? t('轮到你行动了') : t('有人提到了你'))}`,
                  parse_mode: 'HTML',
                }),
              )
              .catch(() => {})
        }
      })
    })
    this.unlisten = subscribeRoomEvents((event) => {
      if (!listBindings().some((b) => b.roomId === event.roomId)) return
      const room = systemDatabase().select().from(rooms).where(eq(rooms.id, event.roomId)).get()
      if (!room || room.hostUserId !== ownerId) return
      for (const binding of listBindings().filter((b) => b.roomId === room.id && b.state === 'active')) {
        // 这里只做调度，实际投递仍在 deliver 中逐收件人裁剪。
        const projected = projectRoomEvent(event, ownerId, room)
        const value = projected.payload.message
        if (value && typeof value === 'object' && 'id' in value) {
          const message = loadMessage(String(value.id))
          if (message.role === 'assistant' && this.generationSubscriptions.has(binding.id)) continue
          void this.deliver(binding, message).catch(() => {})
        }
      }
    })
    this.timer = setInterval(() => this.watchJobs(), 100)
    this.timer.unref()
    this.idleTimer = setInterval(() => {
      for (const [id, entry] of this.runtime.accounts) {
        void checkIdle(id, entry.client).catch(() => {})
        const row = accountRow(id)
        if (
          row.config.presence.confirmed &&
          Object.values(row.presenceSync).some((field) => field.nextRetryAt && field.nextRetryAt <= Date.now())
        )
          void entry.presence.sync().catch(() => {})
      }
    }, 60000)
    this.idleTimer.unref()
  }
  dispose() {
    for (const album of this.albums.values()) clearTimeout(album.timer)
    this.albums.clear()
    this.runtime.dispose()
    this.unlisten()
    this.unlistenNotifications()
    clearInterval(this.timer)
    clearInterval(this.idleTimer)
    for (const dispose of this.generationSubscriptions.values()) dispose()
    for (const stream of this.streams.values()) stream.stream.abort()
    for (const timer of this.presenceTimers.values()) clearTimeout(timer)
    for (const timer of this.editTimers.values()) clearTimeout(timer)
  }
  settings(binding: ChannelBindingDTO) {
    return resolveChannelSettings(accountRow(binding.accountId).config, binding, this.globalSettings())
  }
  async send(accountId: string, chat: string, text: string, thread?: string) {
    const client = this.runtime.accounts.get(accountId)?.client
    if (!client) return
    for (const html of renderTelegram([{ kind: 'text', text }]))
      await client.serialized(chat, () =>
        client.call('sendMessage', {
          chat_id: chat,
          message_thread_id: thread || undefined,
          text: html,
          parse_mode: 'HTML',
        }),
      )
  }
  async receive(id: string, input: unknown) {
    const account = accountRow(id)
    const decoded = decodeTelegram(input, { id: account.botId, username: account.botUsername })
    if (decoded?.type === 'callback')
      await this.runtime.accounts
        .get(id)
        ?.client.call('answerCallbackQuery', { callback_query_id: decoded.id })
        .catch(() => {})
    const previous = this.inputTails.get(id) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(() => this.handle(id, input))
    this.inputTails.set(id, pending)
    try {
      await pending
    } finally {
      if (this.inputTails.get(id) === pending) this.inputTails.delete(id)
    }
  }
  private async handle(id: string, input: unknown) {
    const row = accountRow(id)
    const entry = this.runtime.accounts.get(id)
    if (!entry) return
    const event = decodeTelegram(input, { id: row.botId, username: row.botUsername })
    if (!event) return
    if (!markReceived(id, event.dedupeKey, Date.now())) return
    try {
      if (event.type === 'managed_bot') {
        await receiveManagedBot(this.runtime, id, event)
        return
      }
      if ('chat' in event) {
        const topic =
          event.type === 'message' || event.type === 'edit'
            ? (event.forum_topic_created?.name ?? event.forum_topic_edited?.name)
            : undefined
        const title =
          event.chat.type === 'private'
            ? [event.chat.first_name, event.chat.last_name].filter(Boolean).join(' ') ||
              ('from' in event && event.from
                ? [event.from.first_name, event.from.last_name].filter(Boolean).join(' ')
                : '')
            : (('new_chat_title' in event ? event.new_chat_title : undefined) ?? event.chat.title)
        for (const binding of db
          .select()
          .from(channelBindings)
          .where(and(eq(channelBindings.accountId, id), eq(channelBindings.chat, String(event.chat.id))))
          .all()) {
          const sameTopic = 'message_thread_id' in event && binding.thread === String(event.message_thread_id)
          const topicTitle = sameTopic && topic !== undefined ? topic : binding.topicTitle
          if (topicTitle || title)
            db.update(channelBindings)
              .set({ title: topicTitle || title, topicTitle })
              .where(eq(channelBindings.id, binding.id))
              .run()
        }
      }
      if ('from' in event && event.from) {
        const seen = db
          .select()
          .from(channelActors)
          .where(
            and(eq(channelActors.provider, row.config.provider), eq(channelActors.externalId, String(event.from.id))),
          )
          .get()
        if (seen)
          recordActorSeen(
            id,
            seen,
            'chat' in event ? String(event.chat.id) : String(event.message?.chat.id ?? ''),
            'message_thread_id' in event ? String(event.message_thread_id ?? '') : '',
          )
      }
      if (event.type === 'membership') {
        const chat = String(event.chat.id)
        const status = event.new_chat_member.status
        if (event.chat.type === 'private' && ['kicked', 'left'].includes(status))
          db.update(channelActors)
            .set({ dmChatId: null })
            .where(
              and(eq(channelActors.provider, row.config.provider), eq(channelActors.externalId, String(event.from.id))),
            )
            .run()
        else if (['kicked', 'left'].includes(status)) markLeft(id, chat)
        else if (['member', 'administrator'].includes(status))
          await groupAdded(
            id,
            chat,
            event.chat.title ?? chat,
            String(event.from.id),
            entry.client,
            [event.from.first_name, event.from.last_name].filter(Boolean).join(' '),
          )
        return
      }
      if (event.type === 'callback') {
        await this.callback(id, event)
        return
      }
      if (event.type !== 'message' && event.type !== 'edit') return
      if (event.from.is_bot && (event.forum_topic_created || event.forum_topic_edited || event.new_chat_title)) return
      const actorId = String(event.from.id)
      let actor = db
        .select()
        .from(channelActors)
        .where(and(eq(channelActors.provider, row.config.provider), eq(channelActors.externalId, actorId)))
        .get()
      if (event.command?.name === 'start' && event.chat.type === 'private' && actor?.role !== 'blocked') {
        if (!actor?.linkedUserId) {
          if (actor)
            db.update(channelActors)
              .set({ dmChatId: String(event.chat.id) })
              .where(eq(channelActors.id, actor.id))
              .run()
          const pairingKey = `pair:${id}:${actorId}`
          const attempts = (this.rates.get(pairingKey) ?? []).filter((at) => Date.now() - at < 60000)
          if (attempts.length >= 3) throw new HttpError(429, 'RATE_LIMITED', t('消息发送过于频繁，请稍后重试'))
          this.rates.set(pairingKey, [...attempts, Date.now()])
          db.delete(channelPairings).where(lt(channelPairings.expiresAt, Date.now())).run()
          let code = String(randomInt(100000, 1000000))
          while (db.select().from(channelPairings).where(eq(channelPairings.code, code)).get())
            code = String(randomInt(100000, 1000000))
          db.insert(channelPairings)
            .values({
              code,
              accountId: id,
              externalId: actorId,
              displayName: event.displayName,
              expiresAt: Date.now() + 600000,
            })
            .run()
          await this.send(id, String(event.chat.id), t('请在网页渠道页输入配对码：{code}', { code }))
          return
        }
      }
      if (!actor || actor.role === 'blocked') {
        if (!actor && event.chat.type === 'private')
          requestLocation(
            id,
            'new-location',
            String(event.chat.id),
            event.displayName,
            actorId,
            Date.now(),
            event.displayName,
          )
        await this.send(id, String(event.chat.id), t('请先配对或请主人授权'))
        return
      }
      actor = db
        .update(channelActors)
        .set({
          displayName: event.displayName,
          username: event.from.username ?? null,
          ...(event.chat.type === 'private' ? { dmChatId: String(event.chat.id) } : {}),
        })
        .where(eq(channelActors.id, actor.id))
        .returning()
        .get()
      const rateKey = `${id}:${actor.id}`
      const recent = (this.rates.get(rateKey) ?? []).filter((at) => Date.now() - at < 60000)
      const rateBinding = matchChannelBinding(listBindings(id), {
        scope: event.chat.type === 'private' ? 'private' : 'group',
        chat: String(event.chat.id),
        thread: event.message_thread_id ? String(event.message_thread_id) : '',
        actor: actor.externalId,
      })
      const rateLimit = resolveChannelSettings(row.config, rateBinding, this.globalSettings()).values.actorRateLimit
      if (recent.length >= rateLimit) throw refused()
      this.rates.set(rateKey, [...recent, Date.now()])
      const binding = await this.resolveBinding(id, event, actor)
      if (binding && (event.forum_topic_created || event.forum_topic_edited)) {
        const topicTitle = event.forum_topic_created?.name ?? event.forum_topic_edited?.name
        if (topicTitle && binding.thread === String(event.message_thread_id))
          db.update(channelBindings)
            .set({ title: topicTitle, topicTitle })
            .where(eq(channelBindings.id, binding.id))
            .run()
      }
      if (event.forum_topic_created || event.forum_topic_edited || event.new_chat_title) return
      if (binding?.state !== 'active') return
      syncActorPersona(binding, actor)
      void reactToMessage(this, binding, actor.externalId, event.message_id, entry.client).catch(() => {})
      const { id: bindingId, accountId: _, ...data } = binding
      db.update(channelBindings)
        .set({ ...data, lastActivityAt: Date.now(), idleWarnedAt: null })
        .where(eq(channelBindings.id, bindingId))
        .run()
      if (event.type === 'edit') {
        // 入站作者和外部消息 id 共同定位，不能编辑其他成员的消息。
        const original = this.host
          .getChatInfo(binding.chatId, 1000)
          .messages.find(
            (m) =>
              m.meta.clientMessageId === `telegram:${event.chat.id}:${event.message_id}` &&
              m.meta.author?.userId === (actor.linkedUserId ?? actor.externalUserId),
          )
        if (original && binding.roomId)
          asChannelActor(binding, actor, () => editRoomMessage(binding.roomId!, original.id, event.text))
        return
      }
      if (event.command) {
        await this.command(binding, actor, event)
        return
      }
      const images: string[] = []
      const audio = event.voice ?? event.audio ?? event.video_note
      if (audio) {
        if (!this.settings(binding).values.voiceInput) {
          await this.send(id, binding.chat, t('语音识别尚未启用，请发送文字'), binding.thread)
          return
        }
        await entry.client.serialized(binding.chat, () =>
          entry.client.call('sendChatAction', {
            chat_id: binding.chat,
            message_thread_id: binding.thread || undefined,
            action: 'typing',
          }),
        )
        const bytes = await downloadTelegramFile(entry.client, audio)
        let result: Awaited<ReturnType<ExtensionHost['transcribe']>>
        try {
          result = await this.host.transcribe(
            bytes,
            audio.mime_type ?? (event.video_note ? 'video/mp4' : 'audio/ogg'),
            {
              durationMs: audio.duration === undefined ? undefined : audio.duration * 1000,
            },
          )
        } catch (error) {
          if (!(error instanceof HttpError)) throw error
          await this.send(id, binding.chat, error.message, binding.thread)
          return
        }
        if (result.kind === 'unavailable') {
          await this.send(id, binding.chat, t('语音识别尚未启用，请发送文字'), binding.thread)
          return
        }
        // 附件服务只支持图片；原始音频不伪装成图片，历史只保存识别文本。
        event.text = result.text
        if (this.settings(binding).values.echoTranscript)
          await entry.client.serialized(binding.chat, () =>
            entry.client.call('sendMessage', {
              chat_id: binding.chat,
              message_thread_id: binding.thread || undefined,
              text: `🎤 ${result.text}`.slice(0, 4096),
              reply_parameters: { message_id: event.message_id },
            }),
          )
      }
      const photo =
        event.photo
          ?.filter((p) => (p.file_size ?? 0) <= 20 * 1024 * 1024)
          .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0] ??
        (event.document?.mime_type?.startsWith('image/') ? event.document : undefined)
      if (event.photo?.length && !photo)
        throw new HttpError(413, 'TOO_LARGE', t('文件太大（上限 {limit}MB）', { limit: 20 }))
      if (photo) {
        const bytes = await downloadTelegramFile(entry.client, photo)
        if (binding.roomId) {
          // 房间上传同时登记 room.asset，让后续发送沿用网页端的附件归属校验。
          const form = new FormData()
          form.set('chatId', binding.chatId)
          form.set('file', new Blob([new Uint8Array(bytes)], { type: photo.mime_type ?? 'image/jpeg' }), 'photo')
          const response = await asChannelActor(binding, actor, () =>
            dispatchScope(
              binding.roomId!,
              new Request('http://room/attachments', { method: 'POST', body: form }),
              '/attachments',
            ),
          )
          const attachment = (await response.json()) as { id: string }
          images.push(attachment.id)
        } else images.push((await this.host.saveImage(bytes)).id)
      }
      if (event.media_group_id && images.length) {
        const albumKey = JSON.stringify([id, binding.id, actor.id, event.media_group_id])
        const old = this.albums.get(albumKey)
        if (old) {
          clearTimeout(old.timer)
          old.images.push(...images)
          if (event.text) old.texts.push(event.text)
        }
        const album = old ?? { event, images, texts: event.text ? [event.text] : [], timer: setTimeout(() => {}, 0) }
        clearTimeout(album.timer)
        album.timer = setTimeout(() => {
          this.albums.delete(albumKey)
          const latest = bindingRow(binding.id)
          if (latest.state !== 'active') return
          void this.acceptInput(latest, actor, { ...album.event, text: album.texts.join('\n') }, album.images).catch(
            () => this.runtime.log(id, 'media.album.failed'),
          )
        }, 1500)
        this.albums.set(albumKey, album)
        return
      }
      await this.acceptInput(binding, actor, event, images)
    } catch (error) {
      if (error instanceof HttpError && error.status < 500) {
        if ('chat' in event && event.chat && 'id' in event.chat)
          await this.send(id, String(event.chat.id), error.message)
      } else {
        // 网络异常必须抛给轮询器，撤销去重标记后才允许重放。
        db.delete(channelInbox)
          .where(and(eq(channelInbox.accountId, id), eq(channelInbox.externalEventId, event.dedupeKey)))
          .run()
        throw error
      }
    }
  }
  private async acceptInput(binding: ChannelBindingDTO, actor: ChannelActorDTO, event: MessageEvent, images: string[]) {
    const isOoc = event.text.startsWith('((')
    if (binding.roomId) {
      const memberId = actor.linkedUserId ?? actor.externalUserId
      if (!memberId) throw refused()
      let replyTo: string | undefined
      if (event.reply_to_message || event.mentionsBot) {
        const history = this.host.getChatInfo(binding.chatId, 1000).messages
        const externalReply = event.reply_to_message ? String(event.reply_to_message.message_id) : undefined
        const delivery = externalReply
          ? db
              .select()
              .from(channelDeliveries)
              .where(eq(channelDeliveries.bindingId, binding.id))
              .all()
              .find((d) =>
                d.parts.some((part) => part.externalChat === binding.chat && part.externalId === externalReply),
              )
          : undefined
        replyTo =
          delivery?.messageId ??
          history.find((message) => message.meta.clientMessageId === `telegram:${event.chat.id}:${externalReply}`)?.id
        if (!replyTo && event.mentionsBot)
          replyTo = history
            .filter(
              (message) =>
                message.role === 'assistant' &&
                (!message.meta.visibility || message.meta.visibility.level === 'public'),
            )
            .at(-1)?.id
      }
      const send = () =>
        sendRoomMessage(
          binding.roomId!,
          {
            text: event.text,
            images,
            channel: isOoc ? 'ooc' : 'ic',
            clientMessageId: `telegram:${event.chat.id}:${event.message_id}`,
            replyTo,
          },
          {},
          memberId,
          binding.trigger === 'follow-room' || this.triggered(binding, event),
        )
      asChannelActor(binding, actor, send)
    } else if (this.triggered(binding, event)) {
      if (isOoc)
        this.host.appendMessage(binding.chatId, {
          role: 'user',
          content: event.text,
          meta: { excluded: true, channel: 'ooc' },
        })
      else await this.generate(binding, { mode: 'send', text: event.text, images })
    }
  }
  private triggered(binding: ChannelBindingDTO, event: MessageEvent) {
    return (
      binding.trigger === 'all' ||
      binding.trigger === 'follow-room' ||
      (binding.trigger === 'mention' && event.mentionsBot) ||
      (binding.trigger === 'reply' && event.repliesToBot) ||
      (binding.trigger === 'command' && !!event.command)
    )
  }
  async resolveBinding(id: string, event: MessageEvent, actor: ChannelActorDTO) {
    const config = accountRow(id).config
    const pairedOwner = actor.role === 'owner' && actor.linkedUserId === currentUser().id
    const scope: 'private' | 'group' = event.chat.type === 'private' ? 'private' : 'group'
    const ref: { scope: 'private' | 'group'; chat: string; thread: string; actor: string } = {
      scope,
      chat: String(event.chat.id),
      thread: event.message_thread_id ? String(event.message_thread_id) : '',
      actor: actor.externalId,
    }
    const bindings = listBindings(id)
    const template = bindings.find((b) => b.scope === scope && b.chat === ref.chat)
    const isolation = template?.isolation ?? (scope === 'private' ? 'dm' : 'shared')
    const sharedAccount = bindings.find((b) => b.source === 'account-shared' && b.state === 'active')
    if (sharedAccount && (actor.role !== 'owner' || actor.linkedUserId !== currentUser().id)) throw refused()
    if (
      db
        .select()
        .from(channelRequests)
        .where(
          and(
            eq(channelRequests.accountId, id),
            eq(channelRequests.chat, ref.chat),
            eq(channelRequests.state, 'blocked'),
          ),
        )
        .get()
    )
      throw refused()
    const found = matchChannelBinding(bindings, ref)
    if (found) {
      if (found.source === 'account-shared' && (actor.role !== 'owner' || actor.linkedUserId !== currentUser().id))
        throw refused()
      if (!found.roomId && !pairedOwner) throw refused()
      if (found.roomId && found.state === 'active') {
        let userId: string
        try {
          userId = addChannelMember(
            found.roomId,
            actor,
            event.command?.name === 'agree' ? Number(event.command.args) : undefined,
          )
        } catch (error) {
          if (!(error instanceof HttpError) || error.code !== 'RULES_CHANGED') throw error
          const room = roomRow(found.roomId)
          if (actor.dmChatId)
            await this.send(
              id,
              actor.dmChatId,
              t('请阅读房间规则后发送 /agree {version}：{rules}', {
                version: room.rulesVersion,
                rules: `${room.contentRating}\n${room.contentNotes}\n${room.rules}`,
              }),
            )
          else
            await this.send(
              id,
              found.chat,
              `${t('请先私聊我一次')} https://t.me/${accountRow(id).botUsername}?start=private`,
            )
          return
        }
        if (!actor.linkedUserId && actor.externalUserId !== userId) {
          db.update(channelActors).set({ externalUserId: userId }).where(eq(channelActors.id, actor.id)).run()
          actor.externalUserId = userId
        }
      }
      return found
    }
    const policy = config.policies.newLocation[scope]
    const approval = db
      .select()
      .from(channelRequests)
      .where(
        and(
          eq(channelRequests.accountId, id),
          eq(channelRequests.chat, ref.chat),
          eq(channelRequests.state, 'approved'),
        ),
      )
      .get()
    if (policy === 'existing-only' || (scope === 'private' && !pairedOwner && policy === 'auto' && !approval)) {
      requestLocation(id, 'new-location', ref.chat, event.displayName, actor.externalId, Date.now(), event.displayName)
      return
    }
    if (!approval && policy === 'approve') {
      requestLocation(
        id,
        'new-location',
        ref.chat,
        event.chat.title ?? event.displayName,
        actor.externalId,
        Date.now(),
        event.displayName,
      )
      return
    }
    if (scope === 'group' && config.policies.groupInvite === 'never') {
      const api = this.runtime.accounts.get(id)?.client
      if (api) await api.call('leaveChat', { chat_id: ref.chat })
      return
    }
    const groups = new Set(bindings.filter((b) => b.scope === 'group' && b.state !== 'left').map((b) => b.chat))
    if (scope === 'group' && !groups.has(ref.chat) && groups.size >= config.policies.limits.maxGroups) throw refused()
    if (sharedAccount) {
      const value = {
        ...sharedAccount,
        ...ref,
        title: event.chat.title ?? event.displayName,
        actor: isolation === 'per-user' ? ref.actor : '',
        isolation,
        id: newId(),
        lastActivityAt: Date.now(),
      }
      this.saveBinding(value)
      return bindingRow(value.id)
    }
    const characterId = config.characterMode === 'fixed' ? config.characterId : config.defaultCharacterId
    if (!characterId && !config.groupId) throw new HttpError(409, 'CHARACTER_REQUIRED', t('请先在网页选择角色'))
    const chat = this.host.createChat(config.groupId ? { groupId: config.groupId } : { characterId: characterId! })
    db.update(chats).set({ sourceProvider: config.provider }).where(eq(chats.id, chat.id)).run()
    const room =
      (scope === 'group' && !(['per-user', 'per-topic'].includes(isolation) && pairedOwner)) || !pairedOwner
        ? createRoom(createRoomInput.parse({ name: event.chat.title ?? event.displayName, chatId: chat.id }))
        : null
    const value = channelBindingInput.parse({
      ...ref,
      title: event.chat.title ?? event.displayName,
      actor: isolation === 'per-user' ? ref.actor : '',
      accountId: id,
      chatId: chat.id,
      roomId: room?.id,
      scope,
      isolation,
      state: 'active',
      trigger: scope === 'private' ? 'all' : 'follow-room',
    })
    const binding = {
      ...value,
      id: newId(),
      lastActivityAt: Date.now(),
      idleWarnedAt: null,
      createdBy: currentUser().id,
    }
    this.saveBinding(binding)
    if (room) {
      const userId = addChannelMember(room.id, actor)
      if (!actor.linkedUserId) {
        db.update(channelActors).set({ externalUserId: userId }).where(eq(channelActors.id, actor.id)).run()
        actor.externalUserId = userId
      }
    }
    return bindingRow(binding.id)
  }
  saveBinding(binding: Omit<ChannelBindingDTO, 'memberCount' | 'chatTitle'>, topicTitle?: string) {
    if (binding.source === 'new')
      db.update(chats)
        .set({ sourceProvider: accountRow(binding.accountId).config.provider })
        .where(eq(chats.id, binding.chatId))
        .run()
    const { id, accountId, ...input } = binding
    const data = channelBindingInput.omit({ accountId: true }).parse(input)
    const metadata = {
      lastActivityAt: binding.lastActivityAt,
      idleWarnedAt: binding.idleWarnedAt,
      createdBy: binding.createdBy,
      ...(topicTitle === undefined ? {} : { topicTitle }),
    }
    db.insert(channelBindings)
      .values({ id, accountId, locationKey: locationKey(binding, binding.isolation), ...data, ...metadata })
      .onConflictDoUpdate({
        target: channelBindings.id,
        set: { ...data, ...metadata, locationKey: locationKey(binding, binding.isolation) },
      })
      .run()
    db.insert(channelBindingChats)
      .values({ bindingId: id, chatId: binding.chatId, lastUsedAt: Date.now() })
      .onConflictDoUpdate({
        target: [channelBindingChats.bindingId, channelBindingChats.chatId],
        set: { lastUsedAt: Date.now() },
      })
      .run()
  }
  async generate(binding: ChannelBindingDTO, input: GenerateInput) {
    if (
      input.mode === 'send' &&
      this.host.isGenerating(binding.chatId) &&
      this.settings(binding).values.queueMode === 'merge'
    ) {
      const queued = this.queued.get(binding.id)
      if (queued) {
        queued.texts.push(input.text)
        queued.images.push(...(input.images ?? []))
        return
      }
      const texts = [input.text]
      const images = [...(input.images ?? [])]
      this.queued.set(binding.id, { texts, images })
      void this.host
        .waitIdle(binding.chatId, 120000)
        .then(() => {
          this.queued.delete(binding.id)
          if (bindingRow(binding.id).state !== 'active' || !this.runtime.accounts.has(binding.accountId)) return
          this.host.generate(binding.chatId, { ...input, text: texts.join('\n'), images })
          this.watchJobs()
        })
        .catch(() => {
          this.queued.delete(binding.id)
        })
      return
    }
    if (this.host.isGenerating(binding.chatId)) {
      if (this.settings(binding).values.queueMode === 'interrupt') this.host.abort(binding.chatId)
      await this.host.waitIdle(binding.chatId, 120000)
    }
    this.host.generate(binding.chatId, input)
    this.watchJobs()
  }
  private async command(binding: ChannelBindingDTO, actor: ChannelActorDTO, event: MessageEvent) {
    const command = event.command!
    const roomId = binding.roomId
    const reply = (text: string) => this.send(binding.accountId, binding.chat, text, binding.thread)
    if (command.name === 'vn') {
      const button = miniAppButton(binding)
      return this.runtime.accounts.get(binding.accountId)?.client.call('sendMessage', {
        chat_id: binding.chat,
        message_thread_id: binding.thread ? Number(binding.thread) : undefined,
        text: button ? t('打开 VN') : t('VN 舞台暂不可用'),
        ...(button ? { reply_markup: { inline_keyboard: [[button]] } } : {}),
      })
    }
    if (command.name === 'help') return reply(t('渠道命令帮助'))
    if (command.name === 'agree') {
      if (!roomId) throw refused()
      return asChannelActor(binding, actor, () => acceptRules(roomId, Number(command.args)))
    }
    if (command.name === 'stop')
      return asChannelActor(binding, actor, () => (roomId ? abortTurn(roomId) : this.host.abort(binding.chatId)))
    if (command.name === 'ooc') {
      if (roomId)
        return asChannelActor(binding, actor, () =>
          sendRoomMessage(roomId, { text: command.args, channel: 'ooc', clientMessageId: event.dedupeKey }),
        )
      return this.host.appendMessage(binding.chatId, {
        role: 'user',
        content: command.args,
        meta: { excluded: true, channel: 'ooc' },
      })
    }
    if (command.name === 'ready' || command.name === 'pass') {
      if (!roomId) throw refused()
      return asChannelActor(binding, actor, () => readyRoom(roomId, command.name === 'ready' ? 'done' : 'passed'))
    }
    if (command.name === 'roll') {
      if (!roomId) throw refused()
      const match = /\s+(public|gm|blind|self)$/.exec(command.args)
      const visibility = (match?.[1] as 'public' | 'gm' | 'blind' | 'self' | undefined) ?? 'public'
      const expression = match ? command.args.slice(0, match.index).trim() : command.args
      const result = asChannelActor(binding, actor, () => rollRoom(roomId, { expression, visibility }))
      await this.deliveryTails.get(binding.id)
      if (visibility === 'public' && binding.scope === 'group' && this.settings(binding).values.diceAnimation) {
        const client = this.runtime.accounts.get(binding.accountId)?.client
        // NoBot 的检定结果始终有效；平台随机骰子只作装饰，必须排在结果之后。
        await client
          ?.serialized(binding.chat, () =>
            client.call('sendDice', {
              chat_id: binding.chat,
              message_thread_id: binding.thread || undefined,
              emoji: '🎲',
            }),
          )
          .catch(() => this.runtime.log(binding.accountId, 'media.dice.failed'))
      }
      return result
    }
    if (command.name === 'whisper') {
      if (!roomId) throw refused()
      const target = /^@(\S+)\s+([\s\S]+)$/.exec(command.args)
      const receiver = target
        ? db
            .select()
            .from(channelActors)
            .all()
            .find((a) => a.username === target[1] || a.displayName === target[1])
        : null
      return asChannelActor(binding, actor, () =>
        whisperRoom(roomId, {
          text: target?.[2] ?? command.args,
          to: receiver?.linkedUserId ?? receiver?.externalUserId ?? 'gm',
          clientMessageId: event.dedupeKey,
        }),
      )
    }
    if (command.name === 'chats') {
      const history = db.select().from(channelBindingChats).where(eq(channelBindingChats.bindingId, binding.id)).all()
      const rows = history.map((item) => {
        const token = randomBytes(18).toString('base64url')
        db.insert(channelActions)
          .values({
            token,
            bindingId: binding.id,
            action: 'chat',
            args: { chatId: item.chatId },
            revision: 0,
            allowedActor: actor.externalId,
            expiresAt: Date.now() + 600000,
          })
          .run()
        return [{ text: getChatRow(item.chatId).title, callback_data: token }]
      })
      const entry = this.runtime.accounts.get(binding.accountId)
      return entry?.client.call('sendMessage', {
        chat_id: binding.chat,
        message_thread_id: binding.thread || undefined,
        text: t('选择会话'),
        reply_markup: { inline_keyboard: rows },
      })
    }
    if (command.name === 'persona') {
      const config = accountRow(binding.accountId).config
      if ((binding.personaMode ?? config.personaMode) === 'global' && config.personaLocked) throw refused()
      const selected = chooseActorPersona(binding, actor, command.args)
      if (typeof selected === 'string') return reply(selected)
      if (!selected) throw refused()
      return selected
    }
    if (['regen', 'continue'].includes(command.name)) {
      const targetId = getChatRow(binding.chatId).activeLeafId
      if (!targetId) throw refused()
      const input = { mode: command.name === 'regen' ? ('regenerate' as const) : ('continue' as const), targetId }
      if (roomId) return asChannelActor(binding, actor, () => triggerTurn(roomId, undefined, true, input))
      return this.generate(binding, input)
    }
    if (command.name === 'swipe') {
      const messageId = getChatRow(binding.chatId).activeLeafId
      if (!messageId) throw refused()
      const direction = command.args === 'prev' ? -1 : 1
      if (roomId)
        return asChannelActor(binding, actor, () =>
          dispatchScope(
            roomId,
            new Request(`http://room/api/chats/${binding.chatId}/swipe`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ messageId, direction }),
            }),
            `/chats/${binding.chatId}/swipe`,
          ),
        )
      this.host.swipe(binding.chatId, messageId, direction)
      return this.deliver(binding, loadMessage(getChatRow(binding.chatId).activeLeafId!))
    }
    if (command.name === 'kick' || command.name === 'invite') {
      if (!roomId || !event.reply_to_message?.from) throw refused()
      const target = event.reply_to_message.from
      let member = db
        .select()
        .from(channelActors)
        .where(and(eq(channelActors.provider, 'telegram'), eq(channelActors.externalId, String(target.id))))
        .get()
      if (command.name === 'invite') {
        asChannelActor(binding, actor, () => {
          requireRole(roomId, ['owner', 'gm'])
        })
        if (!member)
          member = db
            .insert(channelActors)
            .values({
              id: newId(),
              provider: 'telegram',
              externalId: String(target.id),
              displayName: target.first_name,
              username: target.username,
              role: 'player',
            })
            .returning()
            .get()
        const userId = addChannelMember(roomId, member)
        db.update(channelActors)
          .set({ externalUserId: member.linkedUserId ? null : userId })
          .where(eq(channelActors.id, member.id))
          .run()
      } else if (member)
        asChannelActor(binding, actor, () =>
          removeMember(roomId, member!.linkedUserId ?? member!.externalUserId ?? '', 'kicked'),
        )
      return
    }
    if (command.name === 'new' || command.name === 'char' || command.name === 'group') {
      if (binding.roomId) asChannelActor(binding, actor, () => requireRole(binding.roomId!, ['owner', 'gm']))
      else asChannelActor(binding, actor, () => {})
      const config = accountRow(binding.accountId).config
      if (command.name !== 'new' && config.characterMode !== 'generic') throw refused()
      const old = getChatRow(binding.chatId)
      const characterId = command.name === 'char' ? command.args : old.characterId
      const groupId = command.name === 'group' ? command.args : command.name === 'char' ? null : old.groupId
      const chat = this.host.createChat(groupId ? { groupId } : { characterId: characterId! })
      db.update(chats).set({ sourceProvider: config.provider }).where(eq(chats.id, chat.id)).run()
      const room = roomId ? createRoom(createRoomInput.parse({ name: chat.title, chatId: chat.id })) : null
      this.saveBinding({ ...binding, chatId: chat.id, roomId: room?.id ?? null })
      return reply(t('已创建新会话'))
    }
    return reply(t('渠道命令帮助'))
  }
  private watchJobs() {
    if (!this.runtime.accounts.size) return
    for (const binding of listBindings().filter(
      (b) => b.state === 'active' && this.runtime.accounts.has(b.accountId),
    )) {
      const key = binding.id
      const job = getJob(binding.chatId)
      if (!job || this.generationSubscriptions.has(key)) continue
      const dispose = this.host.subscribe(job, (event) => {
        const streamKey = `${binding.id}:stream`
        if (event.type === 'start') {
          const entry = this.runtime.accounts.get(binding.accountId)!
          const routed = event.assistantMessage.speakerId
            ? binding.speakers[event.assistantMessage.speakerId]
            : undefined
          const previous = db
            .select()
            .from(channelDeliveries)
            .where(eq(channelDeliveries.bindingId, binding.id))
            .all()
            .find((d) => {
              const old = db.select().from(messages).where(eq(messages.id, d.messageId)).get()
              return (
                old?.id === event.assistantMessage.id ||
                (old?.role === 'assistant' && old.parentId === event.assistantMessage.parentId)
              )
            })
          this.streams.set(streamKey, {
            stream: new DeferredTelegramStream(async () => {
              let selected = entry,
                selectedId = binding.accountId
              const candidate = routed ? this.runtime.accounts.get(routed) : undefined
              if (candidate && routed && routed !== binding.accountId) {
                try {
                  const member = await candidate.client.call<{ status: string }>(
                    'getChatMember',
                    { chat_id: binding.chat, user_id: accountRow(routed).botId },
                    entry.controller.signal,
                  )
                  if (['member', 'administrator', 'creator'].includes(member.status)) {
                    selected = candidate
                    selectedId = routed
                  }
                } catch {
                  /* 未加入或权限读取失败时，由接收账号带名字代发。 */
                }
              }
              const part = previous?.parts[0]
              return new TelegramTextStream(
                selected.client,
                { chat: binding.chat, private: binding.scope === 'private', thread: binding.thread || undefined },
                {
                  signal: selected.controller.signal,
                  intervalMs: this.settings(binding).values.streamIntervalMs,
                  draftId: Date.now() % 2147483647 || 1,
                  accountId: selectedId,
                  messageId: part?.accountId === selectedId ? Number(part.externalId) : undefined,
                },
              )
            }),
            content: event.assistantMessage.content,
            reasoning: event.assistantMessage.meta.reasoning ?? '',
          })
        }
        if (bindingRow(binding.id).state !== 'active') {
          this.streams.get(streamKey)?.stream.abort()
          return
        }
        if (event.type === 'delta') {
          const state = this.streams.get(streamKey)
          if (state && this.settings(binding).values.stream) {
            state.content += event.text
            state.reasoning += event.reasoning ?? ''
            state.stream.update(
              toDisplayText(state.content, { knownNames: [], speaker: 'plain', streaming: true }),
              this.settings(binding).values.thinking === 'fold' ? state.reasoning : '',
            )
          }
        }
        if (event.type === 'done') {
          const state = this.streams.get(streamKey)
          this.streams.delete(streamKey)
          void this.deliver(binding, event.message, state?.stream).catch(() => {})
        }
        if (event.type === 'complete' || event.type === 'error') {
          this.streams.get(streamKey)?.stream.abort()
          this.streams.delete(streamKey)
          this.generationSubscriptions.get(key)?.()
          this.generationSubscriptions.delete(key)
        }
      })
      this.generationSubscriptions.set(key, dispose)
    }
  }
  private async callback(accountId: string, event: Extract<TelegramEvent, { type: 'callback' }>) {
    const action = event.data
      ? db.select().from(channelActions).where(eq(channelActions.token, event.data)).get()
      : null
    if (
      !action ||
      action.expiresAt < Date.now() ||
      action.usedAt ||
      (action.allowedActor && action.allowedActor !== String(event.from.id))
    )
      throw refused()
    const binding = bindingRow(action.bindingId)
    if (
      binding.accountId !== accountId ||
      binding.state !== 'active' ||
      String(event.message?.chat.id) !== binding.chat
    )
      throw refused()
    const actor = db
      .select()
      .from(channelActors)
      .where(and(eq(channelActors.provider, 'telegram'), eq(channelActors.externalId, String(event.from.id))))
      .get()
    if (!actor || actor.role === 'blocked') throw refused()
    if (action.action === 'chat') {
      const target = String(action.args.chatId ?? '')
      if (
        !db
          .select()
          .from(channelBindingChats)
          .where(and(eq(channelBindingChats.bindingId, binding.id), eq(channelBindingChats.chatId, target)))
          .get()
      )
        throw refused()
      if (binding.roomId) asChannelActor(binding, actor, () => requireRole(binding.roomId!, ['owner', 'gm']))
      else asChannelActor(binding, actor, () => {})
      const room = systemDatabase().select().from(rooms).where(eq(rooms.chatId, target)).get()
      this.saveBinding({ ...binding, chatId: target, roomId: room?.id ?? null })
      return
    }
    const last = db
      .select()
      .from(channelDeliveries)
      .where(and(eq(channelDeliveries.bindingId, binding.id), eq(channelDeliveries.messageId, action.messageId ?? '')))
      .get()
    if (!last || last.revision !== action.revision) throw refused()
    if (action.action === 'speak') {
      asChannelActor(binding, actor, () => {})
      const message = action.messageId ? loadMessage(action.messageId) : null
      if (!message || this.settings(binding).values.voice !== 'button') throw refused()
      if (
        message.meta.hidden ||
        message.meta.channel === 'whisper' ||
        (message.meta.visibility && message.meta.visibility.level !== 'public')
      )
        throw refused()
      const sendingId = last.parts[0]?.accountId ?? accountId
      const client = this.runtime.accounts.get(sendingId)?.client
      const identity = accountRow(sendingId).config
      const native = identity.characterMode === 'fixed' && identity.characterId === message.speakerId
      if (client) await this.media.speak(binding, message, client, sendingId, native)
      return
    }
    if (action.action === 'choice' && binding.roomId)
      return asChannelActor(binding, actor, () =>
        pickRoomChoice(binding.roomId!, action.messageId!, Number(action.args.index)),
      )
    const message = action.messageId ? loadMessage(action.messageId) : null
    if (!message || getChatRow(binding.chatId).activeLeafId !== message.id) throw refused()
    if (action.action === 'choice') {
      asChannelActor(binding, actor, () => {})
      const option = parseStageMessage(message.content, { knownNames: [], vars: {}, inline: false, mvu: false }).stage
        .choices?.[Number(action.args.index)]
      if (!option) throw refused()
      const check = option.check ? this.host.performCheck(binding.chatId, option.check) : undefined
      return this.generate(binding, { mode: 'send', text: option.text, images: [], ...(check ? { check } : {}) })
    }
    if (action.action !== 'choice') {
      asChannelActor(binding, actor, () => {
        if (binding.roomId) requireRole(binding.roomId, ['owner', 'gm'])
      })
      const claimed = db
        .update(channelActions)
        .set({ usedAt: Date.now() })
        .where(and(eq(channelActions.token, action.token), isNull(channelActions.usedAt)))
        .returning()
        .all()
      if (!claimed.length) throw refused()
    }
    if (action.action === 'swipe-prev' || action.action === 'swipe-next') {
      const direction = action.action === 'swipe-prev' ? -1 : 1
      if (binding.roomId)
        return asChannelActor(binding, actor, () =>
          dispatchScope(
            binding.roomId!,
            new Request(`http://room/chats/${binding.chatId}/swipe`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ messageId: message.id, direction }),
            }),
            `/chats/${binding.chatId}/swipe`,
          ),
        )
      asChannelActor(binding, actor, () => this.host.swipe(binding.chatId, message.id, direction))
      return this.deliver(binding, loadMessage(getChatRow(binding.chatId).activeLeafId!))
    }
    if (action.action === 'delete') {
      if (binding.roomId) asChannelActor(binding, actor, () => editRoomMessage(binding.roomId!, message.id, null))
      else asChannelActor(binding, actor, () => this.host.deleteMessage(message.id))
      for (const part of last.parts)
        await this.runtime.accounts
          .get(part.accountId)
          ?.client.call('deleteMessage', { chat_id: part.externalChat, message_id: Number(part.externalId) })
      return
    }
    if (['regenerate', 'continue'].includes(action.action)) {
      const input = { mode: action.action as 'regenerate' | 'continue', targetId: message.id }
      if (binding.roomId)
        return asChannelActor(binding, actor, () => triggerTurn(binding.roomId!, undefined, true, input))
      asChannelActor(binding, actor, () => {})
      return this.generate(binding, input)
    }
    throw refused()
  }
  async deliver(binding: ChannelBindingDTO, message: MessageDTO, stream?: TelegramStream) {
    const key = binding.id
    const pending = (this.deliveryTails.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.deliverNow(binding, message, stream))
    this.deliveryTails.set(key, pending)
    try {
      await pending
    } finally {
      if (this.deliveryTails.get(key) === pending) this.deliveryTails.delete(key)
    }
  }
  private async deliverNow(binding: ChannelBindingDTO, message: MessageDTO, stream?: TelegramStream) {
    binding = bindingRow(binding.id)
    let entry = this.runtime.accounts.get(binding.accountId)
    if (!entry || binding.state !== 'active') {
      stream?.abort()
      return
    }
    const privateContent =
      message.meta.channel === 'whisper' ||
      (!!message.meta.visibility && message.meta.visibility.level !== 'public') ||
      !!message.meta.hidden
    if (privateContent) {
      stream?.abort()
      if (!binding.roomId) return
      const actors = db
        .select()
        .from(channelActors)
        .all()
        .filter((a) => a.role !== 'blocked' && (a.linkedUserId || a.externalUserId))
      let hint = false
      for (const actor of actors) {
        const viewer = actor.linkedUserId ?? actor.externalUserId!
        const projected = roomMessage(message, viewer, currentUser().id)
        if (!projected.content || (projected.meta.hidden && projected.meta.hidden.reason !== 'blind')) continue
        // 必须先确认收件人仍是该房间成员；隐藏占位也绝不能进入群聊。
        try {
          asChannelActor(binding, actor, () => {})
        } catch {
          continue
        }
        if (actor.dmChatId) await this.send(binding.accountId, actor.dmChatId, projected.content)
        else hint = true
      }
      if (hint && binding.scope === 'group')
        await this.send(
          binding.accountId,
          binding.chat,
          `${t('请先私聊我一次')} https://t.me/${accountRow(binding.accountId).botUsername}?start=private`,
        )
      return
    }
    await stream?.waitReady()
    let sendingAccountId = binding.accountId
    const speakerAccount = message.speakerId ? binding.speakers[message.speakerId] : undefined
    if (speakerAccount && speakerAccount !== binding.accountId && message.role === 'assistant') {
      const candidate = this.runtime.accounts.get(speakerAccount)
      if (candidate) {
        try {
          const member = await candidate.client.call<{ status: string }>('getChatMember', {
            chat_id: binding.chat,
            user_id: accountRow(speakerAccount).botId,
          })
          if (['member', 'administrator', 'creator'].includes(member.status)) {
            if (stream && stream.accountId !== speakerAccount) {
              stream.abort()
              stream = undefined
            }
            entry = candidate
            sendingAccountId = speakerAccount
          }
        } catch {
          /* 另一只 bot 不在群内时由接收账号带名字代发。 */
        }
      }
    }
    const identity = accountRow(sendingAccountId).config
    const nativeIdentity =
      message.role === 'assistant' &&
      identity.characterMode === 'fixed' &&
      !!identity.characterId &&
      message.speakerId === identity.characterId
    const identityName = nativeIdentity ? this.host.getCharacter(identity.characterId!).name : null
    const settings = this.settings(binding).values
    if (
      message.role === 'user' &&
      (!settings.mirrorWebMessages || String(message.meta.clientMessageId ?? '').startsWith('telegram:'))
    )
      return
    if (message.role !== 'assistant' && message.role !== 'user' && message.role !== 'system') return
    const deliveries = db.select().from(channelDeliveries).where(eq(channelDeliveries.bindingId, binding.id)).all()
    const previous =
      deliveries.find((d) => d.messageId === message.id) ??
      (message.role === 'assistant'
        ? deliveries.find((d) => {
            const old = db.select().from(messages).where(eq(messages.id, d.messageId)).get()
            return old?.role === 'assistant' && old.parentId === message.parentId
          })
        : undefined)
    const visible = toDisplayText(message.content, { knownNames: [], speaker: 'plain', streaming: false })
    const text = `${!nativeIdentity && settings.personaPrefix && message.meta.name ? `${message.meta.name}: ` : ''}${visible}`
    if (!text) {
      stream?.abort()
      await this.media
        .deliver(binding, message, settings, entry.client, sendingAccountId, nativeIdentity)
        .catch(() => this.runtime.log(sendingAccountId, 'media.failed'))
      return
    }
    const contentHash = createHash('sha256')
      .update(JSON.stringify([text, settings.thinking === 'fold' ? message.meta.reasoning : '', sendingAccountId]))
      .digest('hex')
    if (previous?.messageId === message.id && previous.contentHash === contentHash) {
      stream?.abort()
      await this.media
        .deliver(binding, message, settings, entry.client, sendingAccountId, nativeIdentity)
        .catch(() => this.runtime.log(sendingAccountId, 'media.failed'))
      return
    }
    const revision = (previous?.revision ?? -1) + 1
    const choices =
      message.role === 'assistant'
        ? (parseStageMessage(message.content, { knownNames: [], vars: {}, inline: false, mvu: false }).stage.choices ??
          [])
        : []
    const rows: ({ text: string; callback_data: string } | MiniAppButton)[][] = []
    for (const [index, choice] of choices.entries())
      rows.push([{ text: choice.text, callback_data: this.token(binding, message, revision, 'choice', { index }) }])
    if (message.role === 'assistant') {
      const controls = [
        settings.regenerateButton && ['⟲', 'regenerate'],
        settings.previousButton && ['◀', 'swipe-prev'],
        settings.nextButton && ['▶', 'swipe-next'],
        settings.continueButton && ['➕', 'continue'],
        settings.deleteButton && ['🗑', 'delete'],
        settings.voice === 'button' && ['🔊', 'speak'],
      ].filter((x): x is string[] => !!x)
      if (controls.length)
        rows.push(
          controls.map(([text, action]) => ({
            text: text!,
            callback_data: this.token(binding, message, revision, action!, {}),
          })),
        )
    }
    const vnButton = settings.miniAppButton && miniAppButton(binding)
    if (vnButton && message.role === 'assistant') rows.push([vnButton])
    const segments: TelegramSegment[] = []
    if (settings.thinking === 'fold' && message.meta.reasoning)
      segments.push({ kind: 'thinking', text: message.meta.reasoning })
    const stage =
      message.role === 'assistant'
        ? parseStageMessage(message.content, { knownNames: [], vars: {}, inline: false, mvu: false }).stage
        : null
    if (
      !nativeIdentity &&
      settings.personaPrefix &&
      message.meta.name &&
      !stage?.beats.some((beat) => beat.kind === 'line')
    )
      segments.push({ kind: 'speaker', text: `${message.meta.name}: ` })
    if (stage?.beats.some((beat) => beat.kind === 'line')) {
      for (const beat of stage.beats) {
        if (beat.kind === 'line') {
          if (settings.personaPrefix && beat.speaker !== identityName)
            segments.push({ kind: 'speaker', text: `${beat.speaker}: ` })
          segments.push(...inlineTelegramSegments(`${beat.text}\n`))
        }
        if (beat.kind === 'narration') segments.push(...inlineTelegramSegments(`${beat.text}\n`))
      }
    } else segments.push(...inlineTelegramSegments(visible))
    const markup = { inline_keyboard: rows }
    if (stream?.isClosed) stream = undefined
    let ids: number[]
    if (previous && stream) {
      stream.abort()
      stream = undefined
    }
    if (stream) ids = await stream.commit(text, markup, segments)
    else {
      const sender = entry
      ids = await sender.client.serialized(binding.chat, async () => {
        const sentIds: number[] = []
        const pages = renderTelegram(segments)
        for (const [index, html] of pages.entries()) {
          const params = {
            chat_id: binding.chat,
            message_thread_id: binding.thread || undefined,
            text: html,
            parse_mode: 'HTML',
            reply_markup: index === pages.length - 1 ? markup : undefined,
          }
          const old = previous?.parts[index]
          if (old) {
            try {
              await sender.client.call('editMessageText', { ...params, message_id: Number(old.externalId) })
              sentIds.push(Number(old.externalId))
              continue
            } catch {
              /* 平台编辑窗口可能已过，改为引用旧版本。 */
            }
          }
          const result = await sender.client.call<{ message_id: number }>('sendMessage', {
            ...params,
            ...(old ? { reply_parameters: { message_id: Number(old.externalId) } } : {}),
          })
          sentIds.push(result.message_id)
        }
        return sentIds
      })
    }
    if (!previous && message.role === 'assistant') {
      const old = deliveries.at(-1)
      if (old)
        for (const part of old.parts)
          await this.runtime.accounts
            .get(part.accountId)
            ?.client.call('editMessageReplyMarkup', {
              chat_id: part.externalChat,
              message_id: Number(part.externalId),
              reply_markup: { inline_keyboard: [] },
            })
            .catch(() => {})
    }
    db.insert(channelDeliveries)
      .values({
        id: previous?.id ?? newId(),
        bindingId: binding.id,
        messageId: message.id,
        revision,
        parts: ids.map((id) => ({ accountId: sendingAccountId, externalChat: binding.chat, externalId: String(id) })),
        status: 'committed',
        contentHash,
      })
      .onConflictDoUpdate({
        target: channelDeliveries.id,
        set: {
          messageId: message.id,
          revision,
          parts: ids.map((id) => ({
            accountId: sendingAccountId,
            externalChat: binding.chat,
            externalId: String(id),
          })),
          contentHash,
          status: 'committed',
        },
      })
      .run()
    await this.media
      .deliver(binding, message, settings, entry.client, sendingAccountId, nativeIdentity)
      .catch(() => this.runtime.log(sendingAccountId, 'media.failed'))
  }
  private token(
    binding: ChannelBindingDTO,
    message: MessageDTO,
    revision: number,
    action: string,
    args: Record<string, unknown>,
  ) {
    const token = randomBytes(18).toString('base64url')
    db.delete(channelActions).where(lt(channelActions.expiresAt, Date.now())).run()
    db.insert(channelActions)
      .values({
        token,
        bindingId: binding.id,
        action,
        args,
        messageId: message.id,
        revision,
        allowedActor: binding.isolation === 'per-user' ? binding.actor : null,
        expiresAt: Date.now() + 86400000,
      })
      .run()
    return token
  }
  onEvent(event: ServerEvent) {
    if (event.type === 'character:updated') {
      for (const [id, entry] of this.runtime.accounts) {
        const config = accountRow(id).config
        if (
          (config.characterMode === 'fixed' ? config.characterId : config.presence.characterId) !== event.characterId ||
          !config.presence.confirmed
        )
          continue
        clearTimeout(this.presenceTimers.get(id))
        this.presenceTimers.set(
          id,
          setTimeout(() => {
            this.presenceTimers.delete(id)
            void entry.presence.sync().catch(() => {})
          }, 30000),
        )
      }
    }
    if (event.type === 'message:deleted') {
      for (const binding of listBindings().filter((b) => b.chatId === event.chatId && b.state === 'active')) {
        if (!this.settings(binding).values.deleteSync) continue
        const deliveries = db
          .select()
          .from(channelDeliveries)
          .where(eq(channelDeliveries.bindingId, binding.id))
          .all()
          .filter((d) => event.messageIds.includes(d.messageId))
        for (const delivery of deliveries) {
          for (const part of delivery.parts)
            void this.runtime.accounts
              .get(part.accountId)
              ?.client.call('deleteMessage', { chat_id: part.externalChat, message_id: Number(part.externalId) })
              .catch(() => {})
          db.update(channelDeliveries).set({ status: 'superseded' }).where(eq(channelDeliveries.id, delivery.id)).run()
        }
      }
    }
    if (event.type === 'message:saved' && (event.message.meta.imageGen || event.message.meta.images?.length)) {
      for (const binding of listBindings().filter((b) => b.chatId === event.message.chatId && b.state === 'active'))
        void this.deliver(binding, event.message).catch(() => {})
    }
    if (event.type === 'message:updated') {
      for (const binding of listBindings().filter((b) => b.chatId === event.message.chatId && b.state === 'active')) {
        if (
          getChatRow(binding.chatId).activeLeafId !== event.message.id &&
          !event.message.meta.imageGen &&
          !event.message.meta.cg
        )
          continue
        clearTimeout(this.editTimers.get(`${binding.id}:${event.message.id}`))
        this.editTimers.set(
          `${binding.id}:${event.message.id}`,
          setTimeout(() => {
            this.editTimers.delete(`${binding.id}:${event.message.id}`)
            if (
              getChatRow(binding.chatId).activeLeafId === event.message.id ||
              event.message.meta.imageGen ||
              event.message.meta.cg
            )
              void this.deliver(binding, event.message).catch(() => {})
          }, this.settings(binding).values.streamIntervalMs),
        )
      }
    }
  }
}
