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
  characters,
  chats,
  groupMembers,
  groups,
  messages,
} from '../../../db/schema'
import { systemDatabase } from '../../../db/system-client'
import { rooms } from '../../../db/system-schema'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { getChatRow, loadMessage, loadPath } from '../../../services/chats'
import { getJob } from '../../../services/generation/generation'
import { stageMembers } from '../../../services/generation/stage'
import {
  acceptRules,
  checkQuota,
  createRoom,
  projectRoomEvent,
  removeMember,
  requireRole,
  roomDetail,
  roomRow,
  subscribeRoomEvents,
} from '../../../services/rooms'
import { roomMessage } from '../../../services/rooms/dto'
import { dispatchScope } from '../../../services/rooms/scope'
import { pickRoomChoice, readyRoom, rollRoom, whisperRoom } from '../../../services/rooms/trpg'
import { abortTurn, editRoomMessage, sendRoomMessage, triggerTurn } from '../../../services/rooms/turns'
import { subscribeSocialNotifications } from '../../../services/social'
import { currentUser, runAsUser } from '../../../user-context'
import { forwardExtension } from '../../registry'
import type { ExtensionHost, ServerEvent } from '../../types'
import { OneBotClient, splitOneBot } from './adapters/onebot11/client'
import { signBudget, socialBudget } from './adapters/onebot11/interactions'
import { decodeOneBot } from './adapters/onebot11/receive'
import { receiveOneBotSocial } from './adapters/onebot11/social'
import { downloadTelegramFile } from './adapters/telegram/media'
import { decodeTelegram, type TelegramEvent } from './adapters/telegram/receive'
import { escapeHtml, inlineTelegramSegments, renderTelegram, type TelegramSegment } from './adapters/telegram/render'
import { DeferredTelegramStream, type TelegramStream, TelegramTextStream } from './adapters/telegram/stream'
import { imagineLabel, imagineModes, parseImagine } from './imagine'
import { receiveManagedBot } from './managed-bots'
import { type MiniAppButton, miniAppButton, oneTimeStageUrl } from './miniapp'
import { OutboundMedia } from './outbound-media'
import { chooseActorPersona, syncActorPersona } from './personas'
import { checkIdle, groupAdded, markLeft, requestLocation } from './policies'
import { reactToMessage } from './reactions'
import { addChannelMember, asChannelActor } from './rooms'
import { ChannelRuntime } from './runtime'
import { locationKey, matchChannelBinding, resolveChannelSettings } from './settings'
import { omitSpeakerPrefix } from './speaker-prefix'
import { sendMessageStickers } from './sticker-delivery'
import { learnQqSticker, learnTelegramSticker, qqStickerMeaning, telegramStickerSchema } from './stickers'
import { accountRow, bindingRow, listBindings, markReceived, recordActorSeen } from './store'
import { cleanProtocolText, isImageMessage, visibleContent, visibleText } from './visible-text'
import { replyVoiceStyle, updateVoicePreference, voiceDeliverySettings } from './voice-decision'

const refused = () => new HttpError(403, 'CHANNEL_REFUSED', t('没有渠道操作权限'))
type MessageEvent = Extract<TelegramEvent, { type: 'message' | 'edit' }>
export class ChannelService {
  readonly runtime: ChannelRuntime
  readonly media: OutboundMedia
  private oneBotTurns = new Map<string, MessageDTO[]>()
  private privateDeliveryTails = new Map<string, Promise<unknown>>()
  private triggers = new Map<string, number>()
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
    this.oneBotTurns.clear()
    this.media.dispose()
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
    if (entry.client instanceof OneBotClient) {
      const raw = input as Record<string, unknown>
      if (raw?.post_type === 'notice' && raw.sub_type === 'poke' && String(raw.target_id) === entry.client.selfId) {
        await this.oneBotPoke(id, raw, entry.client)
        return
      }
      if (await receiveOneBotSocial(id, input, entry.client)) return
    }
    const event =
      entry.client instanceof OneBotClient
        ? decodeOneBot(input, entry.client, (segment) => qqStickerMeaning(id, segment))
        : decodeTelegram(input, { id: row.botId, username: row.botUsername })
    if (!event) return
    if (!markReceived(id, event.dedupeKey, Date.now())) return
    if (entry.client instanceof OneBotClient && event.type === 'message' && event.reply_to_message) {
      const quoted = event.reply_to_message
      const delivery = db
        .select()
        .from(channelDeliveries)
        .all()
        .find((item) =>
          item.parts.some(
            (part) =>
              part.accountId === id &&
              part.externalChat === String(event.chat.id) &&
              part.externalId === String(quoted.message_id),
          ),
        )
      event.repliesToBot = !!delivery
      if (!quoted.from && event.command && ['invite', 'kick'].includes(event.command.name)) {
        const original = await entry.client.action<{
          sender?: { user_id: number; nickname?: string }
          user_id?: number
        }>('get_msg', { message_id: quoted.message_id })
        const user = original.sender?.user_id ?? original.user_id
        if (user) quoted.from = { id: user, first_name: original.sender?.nickname ?? String(user) }
      }
    }
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
      // 已绑定位置内任何人的原生表情都可学习，但这不授予发言、入房或触发生成的权限。
      const stickerBinding = listBindings(id).find(
        (binding) =>
          binding.state === 'active' &&
          binding.chat === String(event.chat.id) &&
          binding.scope === (event.chat.type === 'private' ? 'private' : 'group') &&
          (binding.isolation !== 'per-topic' ||
            binding.thread === (event.message_thread_id ? String(event.message_thread_id) : '')),
      )
      const learnStickers = async () => {
        const sticker = telegramStickerSchema.safeParse(event.sticker)
        if (sticker.success) event.text = await learnTelegramSticker(id, sticker.data, entry.client)
        for (const native of event.nativeStickers ?? []) learnQqSticker(id, native)
      }
      if (stickerBinding?.state === 'active') await learnStickers()
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
      if (entry.client instanceof OneBotClient) {
        const number = /^(?:\/(?:char|group|imagine|sd)\s+)?([1-9]\d*)$/.exec(event.text)
        if (number) {
          const action = db
            .select()
            .from(channelActions)
            .all()
            .sort((a, b) => b.expiresAt - a.expiresAt)
            .find(
              (item) =>
                (event.command && ['imagine', 'sd'].includes(event.command.name)
                  ? item.action === 'imagine'
                  : event.command && ['char', 'group'].includes(event.command.name)
                    ? item.action === 'picker'
                    : ['picker', 'imagine'].includes(item.action)) &&
                item.args.accountId === id &&
                item.allowedActor === actor.externalId &&
                item.expiresAt > Date.now() &&
                !item.usedAt &&
                item.args.number === Number(number[1]) &&
                (item.args.event as MessageEvent).chat.id === event.chat.id &&
                (item.args.event as MessageEvent).message_thread_id === event.message_thread_id,
            )
          if (action) {
            await this.callback(id, {
              type: 'callback',
              id: '',
              data: action.token,
              from: event.from,
              message: {
                message_id: event.message_id,
                chat: event.chat,
                entities: [],
                message_thread_id: event.message_thread_id,
              },
              dedupeKey: event.dedupeKey,
            })
            return
          }
        }
      }
      if (event.command && ['char', 'group'].includes(event.command.name)) {
        await this.pickerCommand(id, actor, event, rateBinding)
        return
      }
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
      if (stickerBinding?.state !== 'active') await learnStickers()
      syncActorPersona(binding, actor)
      if (entry.client instanceof OneBotClient) {
        this.triggers.set(binding.id, event.message_id)
        await this.syncOneBotCard(binding)
        const settings = this.settings(binding).values
        if (
          binding.scope === 'group' &&
          entry.client.napcat &&
          settings.dailySign &&
          signBudget(id, binding.chat) &&
          socialBudget(id, `sign:${binding.chat}`, settings)
        )
          void entry.client
            .action('set_group_sign', { group_id: Number(binding.chat.replace(/^-/, '')) })
            .catch(() => this.runtime.log(id, 'onebot.sign.failed'))
        if (event.document) {
          await this.send(id, binding.chat, t('暂不支持文件消息，请发送文字或图片'))
          return
        }
        const number = /^(?:\/choose\s+)?([1-9]\d*)$/.exec(event.text)
        const leaf = this.numberedChoiceMessage(binding)
        const hasChoices = !!leaf?.meta.stage?.choices?.length
        const hasMenu = db
          .select()
          .from(channelActions)
          .where(eq(channelActions.bindingId, binding.id))
          .all()
          .some(
            (action) =>
              action.action === 'chat' && action.allowedActor === actor.externalId && action.expiresAt > Date.now(),
          )
        if (number && (hasChoices || hasMenu)) {
          await this.chooseNumber(binding, actor, Number(number[1]))
          return
        }
      }
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
              m.meta.clientMessageId ===
                `${accountRow(binding.accountId).config.provider}:${event.chat.id}:${event.message_id}` &&
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
      for (const photoItem of entry.client instanceof OneBotClient
        ? (event.photo ?? (photo ? [photo] : []))
        : photo
          ? [photo]
          : []) {
        const photo = photoItem
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
        if (
          error.status === 403 &&
          'command' in event &&
          event.command &&
          ['imagine', 'sd'].includes(event.command.name) &&
          'chat' in event
        )
          return this.send(id, String(event.chat.id), t('没有图片生成权限'), String(event.message_thread_id ?? ''))
        if (entry.client instanceof OneBotClient && 'from' in event && event.from) {
          if (await entry.client.privateAllowed(String(event.from.id)).catch(() => false))
            await this.send(id, String(event.from.id), error.message)
          else if ('chat' in event) await this.send(id, String(event.chat.id), t('请先私聊我一次'))
        } else if ('chat' in event && event.chat && 'id' in event.chat)
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
    if (binding.roomId) updateVoicePreference(binding, event.text, this.settings(binding).values)
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
          history.find(
            (message) =>
              message.meta.clientMessageId ===
              `${accountRow(binding.accountId).config.provider}:${event.chat.id}:${externalReply}`,
          )?.id
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
            clientMessageId: `${accountRow(binding.accountId).config.provider}:${event.chat.id}:${event.message_id}`,
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
  private pickerPermission(
    accountId: string,
    actor: ChannelActorDTO,
    event: MessageEvent,
    binding?: ChannelBindingDTO,
  ) {
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
  private async showPicker(
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
      return this.send(
        accountId,
        String(event.chat.id),
        t('没有匹配的角色或群组'),
        String(event.message_thread_id ?? ''),
      )
    const client = this.runtime.accounts.get(accountId)?.client
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
    const onebot = client instanceof OneBotClient
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
      return this.send(
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
  private async selectPicker(
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
      const created = await this.resolveBinding(accountId, event, actor, { kind, id: targetId })
      if (!created) return
    } else {
      const chat = this.host.createChat(kind === 'group' ? { groupId: targetId } : { characterId: targetId })
      const room = binding.roomId ? createRoom(createRoomInput.parse({ name: chat.title, chatId: chat.id })) : null
      this.saveBinding({ ...binding, chatId: chat.id, roomId: room?.id ?? null })
    }
    await this.send(
      accountId,
      String(event.chat.id),
      t('已选择，请重新发送消息'),
      String(event.message_thread_id ?? ''),
    )
  }
  private async pickerCommand(
    accountId: string,
    actor: ChannelActorDTO,
    event: MessageEvent,
    binding?: ChannelBindingDTO,
  ) {
    const config = accountRow(accountId).config
    if (config.characterMode === 'fixed') {
      const name = config.characterId
        ? this.host.getCharacter(config.characterId).name
        : (db
            .select()
            .from(groups)
            .where(eq(groups.id, config.groupId ?? ''))
            .get()?.name ?? config.name)
      return this.send(
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
  async resolveBinding(
    id: string,
    event: MessageEvent,
    actor: ChannelActorDTO,
    selection?: { kind: 'char' | 'group'; id: string },
  ) {
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
    const characterId = selection
      ? selection.kind === 'char'
        ? selection.id
        : null
      : config.characterMode === 'fixed'
        ? config.characterId
        : config.defaultCharacterId
    const groupId = selection ? (selection.kind === 'group' ? selection.id : null) : config.groupId
    if (!characterId && !groupId) {
      await this.showPicker(id, actor, event)
      return
    }
    const chat = this.host.createChat(groupId ? { groupId } : { characterId: characterId! })
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
    void this.syncOneBotCard(bindingRow(id)).catch(() => {})
    db.insert(channelBindingChats)
      .values({ bindingId: id, chatId: binding.chatId, lastUsedAt: Date.now() })
      .onConflictDoUpdate({
        target: [channelBindingChats.bindingId, channelBindingChats.chatId],
        set: { lastUsedAt: Date.now() },
      })
      .run()
  }
  async generate(binding: ChannelBindingDTO, input: GenerateInput) {
    if (input.mode === 'send') updateVoicePreference(binding, input.text, this.settings(binding).values)
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
  private async imagine(binding: ChannelBindingDTO, actor: ChannelActorDTO, event: MessageEvent) {
    const reply = (text: string) => this.send(binding.accountId, binding.chat, text, binding.thread)
    try {
      asChannelActor(binding, actor, () => {
        if (binding.roomId) {
          const detail = roomDetail(binding.roomId)
          if (!detail.permissions.canGenerateImages) throw refused()
          checkQuota(roomRow(binding.roomId), actor.linkedUserId ?? actor.externalUserId!)
        }
      })
      const names = this.host.getChatInfo(binding.chatId, 0).characters.map((c) => c.name)
      const input = event.command?.args.trim() ?? ''
      const parsed = parseImagine(input, names)
      const needsCharacter =
        ['character', 'portrait', 'face'].includes(parsed.args.mode!) && !parsed.args.character && names.length > 1
      if (!input || needsCharacter) {
        const client = this.runtime.accounts.get(binding.accountId)?.client
        if (!client) return
        const choices = needsCharacter
          ? names.map((name) => ({
              label: name,
              input: `${parsed.args.mode} "${name}" ${parsed.args.orientation ?? ''} ${parsed.text}`,
            }))
          : imagineModes.map((mode) => ({ label: imagineLabel(mode), input: mode }))
        // 同一位置的数字菜单只保留最新一份，避免回复命中旧模式或旧角色。
        for (const action of db.select().from(channelActions).all()) {
          if (
            action.action === 'imagine' &&
            action.bindingId === binding.id &&
            action.allowedActor === actor.externalId
          )
            db.delete(channelActions).where(eq(channelActions.token, action.token)).run()
        }
        const buttons = choices.map((choice, index) => {
          const token = randomBytes(12).toString('base64url')
          db.insert(channelActions)
            .values({
              token,
              bindingId: binding.id,
              action: 'imagine',
              revision: 0,
              allowedActor: actor.externalId,
              expiresAt: Date.now() + 600000,
              args: {
                accountId: binding.accountId,
                chatId: binding.chatId,
                event,
                input: choice.input,
                number: index + 1,
              },
            })
            .run()
          return { text: choice.label, callback_data: token }
        })
        const title = needsCharacter ? t('选择要绘制的角色') : t('选择生图模式')
        if (client instanceof OneBotClient)
          return reply(
            `${title}\n${t('回复数字或 /imagine N')}\n${buttons.map((b, i) => `${i + 1}. ${b.text}`).join('\n')}`,
          )
        const rows = []
        for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3))
        await client.call('sendMessage', {
          chat_id: binding.chat,
          message_thread_id: binding.thread || undefined,
          text: title,
          reply_markup: { inline_keyboard: rows },
        })
        return
      }
      if (parsed.args.mode === 'free' && !parsed.text) return reply(t('请在 /imagine 后输入图片描述'))
      const request = new Request('http://channel/api/ext/image-gen/commands/imagine', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: binding.chatId, ...parsed }),
      })
      const response = await (binding.roomId
        ? asChannelActor(binding, actor, () =>
            dispatchScope(binding.roomId!, request, '/ext/image-gen/commands/imagine'),
          )
        : forwardExtension('image-gen', request))
      if (!response.ok)
        return reply(
          [400, 404].includes(response.status)
            ? t('图片生成尚未配置或未启用')
            : response.status === 429
              ? t('房间生成额度已用尽，请稍后重试')
              : t('图片生成失败，请检查生图设置后重试'),
        )
    } catch (error) {
      return reply(
        error instanceof HttpError && error.status === 403
          ? t('没有图片生成权限')
          : error instanceof HttpError && error.status === 404
            ? t('图片生成尚未配置或未启用')
            : error instanceof HttpError && error.status === 429
              ? t('房间生成额度已用尽，请稍后重试')
              : t('图片生成失败，请检查生图设置后重试'),
      )
    }
  }
  private async command(binding: ChannelBindingDTO, actor: ChannelActorDTO, event: MessageEvent) {
    const command = event.command!
    const roomId = binding.roomId
    const reply = (text: string) => this.send(binding.accountId, binding.chat, text, binding.thread)
    if (command.name === 'vn' && accountRow(binding.accountId).config.provider === 'onebot11') {
      asChannelActor(binding, actor, () => {})
      const client = this.runtime.accounts.get(binding.accountId)?.client
      if (!(client instanceof OneBotClient)) return
      if (
        !(await client.privateAllowed(
          actor.externalId,
          binding.scope === 'group' ? binding.chat : undefined,
          this.settings(binding).values.tempSessionDm,
        ))
      )
        return reply(t('请先私聊我一次'))
      const url = oneTimeStageUrl(binding, actor)
      if (!url) return reply(t('VN 舞台暂不可用'))
      return client.send(
        actor.externalId,
        [{ type: 'text', data: { text: `${t('打开 VN')} ${url}` } }],
        'private',
        this.settings(binding).values.tempSessionDm && binding.scope === 'group'
          ? { group_id: Number(binding.chat.slice(1)) }
          : {},
      )
    }
    if (['imagine', 'sd'].includes(command.name)) return this.imagine(binding, actor, event)
    if (command.name === 'speak') {
      asChannelActor(binding, actor, () => {})
      if (this.settings(binding).values.voice === 'off') return reply(t('当前渠道已关闭语音'))
      const deliveries = db.select().from(channelDeliveries).where(eq(channelDeliveries.bindingId, binding.id)).all()
      const quoted = event.reply_to_message
      // 引用必须命中当前绑定的真实投递；无效引用不能悄悄朗读另一条消息。
      const delivery = quoted
        ? deliveries.find((item) =>
            item.parts.some(
              (part) => part.externalChat === binding.chat && part.externalId === String(quoted.message_id),
            ),
          )
        : undefined
      const message = quoted
        ? delivery && loadMessage(delivery.messageId)
        : loadPath(getChatRow(binding.chatId).activeLeafId).findLast((item) => item.role === 'assistant')
      if (!message) return reply(t('没有可朗读的助手消息，请引用一条已投递的回复'))
      const targetDelivery = delivery ?? deliveries.find((item) => item.messageId === message.id)
      return this.speak(binding, actor, message, targetDelivery?.parts[0]?.accountId ?? binding.accountId)
    }
    if (command.name === 'choose') return this.chooseNumber(binding, actor, Number(command.args))
    if (command.name === 'vn') {
      const button = miniAppButton(binding)
      return this.runtime.accounts.get(binding.accountId)?.client.call('sendMessage', {
        chat_id: binding.chat,
        message_thread_id: binding.thread ? Number(binding.thread) : undefined,
        text: button ? t('打开 VN') : t('VN 舞台暂不可用'),
        ...(button ? { reply_markup: { inline_keyboard: [[button]] } } : {}),
      })
    }
    if (command.name === 'help') return reply(`${t('渠道命令帮助')} /imagine (/sd) /speak`)
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
            .find((a) => a.username === target[1] || a.displayName === target[1] || a.externalId === target[1])
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
      if (accountRow(binding.accountId).config.provider === 'onebot11')
        this.clearNumberedMenu(binding.id, actor.externalId)
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
        .where(
          and(
            eq(channelActors.provider, accountRow(binding.accountId).config.provider),
            eq(channelActors.externalId, String(target.id)),
          ),
        )
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
              provider: accountRow(binding.accountId).config.provider,
              externalId: String(target.id),
              displayName: target.first_name,
              username: target.username,
              role: 'player',
            })
            .returning()
            .get()
        member = recordActorSeen(binding.accountId, member, binding.chat, binding.thread)
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
    if (command.name === 'new') {
      if (binding.roomId) asChannelActor(binding, actor, () => requireRole(binding.roomId!, ['owner', 'gm']))
      else asChannelActor(binding, actor, () => {})
      const config = accountRow(binding.accountId).config
      const old = getChatRow(binding.chatId)
      const characterId = old.characterId
      const groupId = old.groupId
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
    for (const [id, entry] of this.runtime.accounts)
      if (
        entry.client instanceof OneBotClient &&
        resolveChannelSettings(accountRow(id).config, undefined, this.globalSettings()).values.onlineStatus === 'follow'
      ) {
        const bindings = listBindings(id).filter((binding) => binding.state === 'active')
        const busy = bindings.some((binding) => this.host.isGenerating(binding.chatId))
        const paused = bindings.some((binding) => binding.roomId && roomRow(binding.roomId).status === 'paused')
        entry.client.onlineStatus(busy ? 50 : paused ? 30 : 10)
      }
    for (const binding of listBindings().filter(
      (b) => b.state === 'active' && this.runtime.accounts.has(b.accountId),
    )) {
      const key = binding.id
      const job = getJob(binding.chatId)
      if (!job || this.generationSubscriptions.has(key)) continue
      const dispose = this.host.subscribe(job, (event) => {
        const streamKey = `${binding.id}:stream`
        if (
          event.type === 'start' &&
          !['only', 'decide'].includes(this.settings(binding).values.voice) &&
          !(
            this.settings(binding).values.voice === 'button' &&
            replyVoiceStyle(binding, event.assistantMessage, this.settings(binding).values)
          ) &&
          !(this.runtime.accounts.get(binding.accountId)?.client instanceof OneBotClient)
        ) {
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
              toDisplayText(cleanProtocolText(state.content), { knownNames: [], speaker: 'plain', streaming: true }),
              this.settings(binding).values.thinking === 'fold' ? state.reasoning : '',
            )
          }
        }
        if (event.type === 'done') {
          const state = this.streams.get(streamKey)
          this.streams.delete(streamKey)
          if (
            this.runtime.accounts.get(binding.accountId)?.client instanceof OneBotClient &&
            binding.scope === 'group' &&
            this.settings(binding).values.multiSpeaker === 'forward' &&
            !event.message.meta.hidden &&
            event.message.meta.channel !== 'whisper' &&
            (!event.message.meta.visibility || event.message.meta.visibility.level === 'public')
          ) {
            this.oneBotTurns.set(binding.id, [...(this.oneBotTurns.get(binding.id) ?? []), event.message])
          } else void this.deliver(binding, event.message, state?.stream).catch(() => {})
        }
        if (event.type === 'complete' || event.type === 'error') {
          const turn = this.oneBotTurns.get(binding.id)
          this.oneBotTurns.delete(binding.id)
          if (turn?.length)
            void this.deliverOneBotTurn(binding, turn).catch(() =>
              this.runtime.log(binding.accountId, 'onebot.turn.failed'),
            )
          this.streams.get(streamKey)?.stream.abort()
          this.streams.delete(streamKey)
          this.generationSubscriptions.get(key)?.()
          this.generationSubscriptions.delete(key)
        }
      })
      this.generationSubscriptions.set(key, dispose)
    }
  }
  /** 命令与按钮共用权限和公开性检查，合成仍走底层内容缓存，修订后自动使用新内容。 */
  private async speak(binding: ChannelBindingDTO, actor: ChannelActorDTO, message: MessageDTO, sendingId: string) {
    asChannelActor(binding, actor, () => {})
    if (
      message.chatId !== binding.chatId ||
      message.role !== 'assistant' ||
      isImageMessage(message) ||
      message.meta.hidden ||
      message.meta.channel === 'whisper' ||
      (message.meta.visibility && message.meta.visibility.level !== 'public')
    )
      throw refused()
    const reply = (text: string) => this.send(binding.accountId, binding.chat, text, binding.thread)
    if (this.settings(binding).values.voice === 'off') return reply(t('当前渠道已关闭语音'))
    const client = this.runtime.accounts.get(sendingId)?.client
    if (!client) return reply(t('语音发送失败，请稍后重试'))
    const identity = accountRow(sendingId).config
    const native = identity.characterMode === 'fixed' && identity.characterId === message.speakerId
    const error = await this.media.speak(binding, message, client, sendingId, native, this.settings(binding).values)
    if (error) await reply(error)
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
    if (action.action === 'picker') {
      const original = action.args.event as MessageEvent
      if (
        action.args.accountId !== accountId ||
        String(event.message?.chat.id) !== String(original.chat.id) ||
        event.message?.message_thread_id !== original.message_thread_id
      )
        throw refused()
      const actor = db
        .select()
        .from(channelActors)
        .where(
          and(
            eq(channelActors.provider, accountRow(accountId).config.provider),
            eq(channelActors.externalId, String(event.from.id)),
          ),
        )
        .get()
      if (!actor) throw refused()
      const binding = matchChannelBinding(listBindings(accountId), {
        scope: original.chat.type === 'private' ? 'private' : 'group',
        chat: String(original.chat.id),
        thread: String(original.message_thread_id ?? ''),
        actor: actor.externalId,
      })
      if ((binding?.id ?? null) !== action.bindingId) throw refused()
      if (typeof action.args.page === 'number')
        return this.showPicker(
          accountId,
          actor,
          original,
          binding,
          action.args.kind as 'char' | 'group' | 'all',
          String(action.args.query ?? ''),
          action.args.page,
        )
      if (action.args.targetKind !== 'char' && action.args.targetKind !== 'group') throw refused()
      this.pickerPermission(accountId, actor, original, binding)
      const claimed = db
        .update(channelActions)
        .set({ usedAt: Date.now() })
        .where(and(eq(channelActions.token, action.token), isNull(channelActions.usedAt)))
        .returning()
        .all()
      if (!claimed.length) throw refused()
      await this.selectPicker(accountId, actor, original, action.args.targetKind, String(action.args.targetId), binding)
      db.update(channelActions).set({ usedAt: Date.now() }).where(eq(channelActions.token, action.token)).run()
      return
    }
    if (!action.bindingId) throw refused()
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
      .where(
        and(
          eq(channelActors.provider, accountRow(accountId).config.provider),
          eq(channelActors.externalId, String(event.from.id)),
        ),
      )
      .get()
    if (!actor || actor.role === 'blocked') throw refused()
    if (action.action === 'imagine') {
      const original = action.args.event as MessageEvent
      if (event.message?.message_thread_id !== original.message_thread_id || action.args.chatId !== binding.chatId)
        throw refused()
      db.update(channelActions).set({ usedAt: Date.now() }).where(eq(channelActions.token, action.token)).run()
      return this.imagine(binding, actor, {
        ...original,
        command: { name: 'imagine', args: String(action.args.input) },
      })
    }
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
      const message = action.messageId ? loadMessage(action.messageId) : null
      if (!message) throw refused()
      await this.speak(binding, actor, message, last.parts[0]?.accountId ?? accountId)
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
      const option = message.meta.stage?.choices?.[Number(action.args.index)]
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
    // OneBot 的多角色转发尚未发出时，先排入前面的正文，再排工具图片。
    if (isImageMessage(message) || message.meta.stickers?.length) {
      const turn = this.oneBotTurns.get(binding.id)
      this.oneBotTurns.delete(binding.id)
      for (const previous of turn ?? []) void this.deliver(binding, previous).catch(() => {})
    }
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
    if (!entry || binding.state !== 'active' || message.chatId !== binding.chatId) {
      // 绑定切换会话后，旧生成订阅的迟到结果不能进入新位置。
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
      const client = entry.client
      const key = `${binding.accountId}:${message.id}`
      const pending = (this.privateDeliveryTails.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          const actors = db
            .select()
            .from(channelActors)
            .all()
            .filter(
              (a) =>
                a.provider === accountRow(binding.accountId).config.provider &&
                a.role !== 'blocked' &&
                (a.linkedUserId || a.externalUserId),
            )
          const hash = createHash('sha256').update(JSON.stringify(message)).digest('hex')
          const previous = db.select().from(channelDeliveries).where(eq(channelDeliveries.messageId, message.id)).all()
          const parts =
            previous.find((delivery) => delivery.bindingId === binding.id && delivery.contentHash === hash)?.parts ?? []
          let hint = false
          for (const actor of actors) {
            const viewer = actor.linkedUserId ?? actor.externalUserId!
            const projected = roomMessage(message, viewer, currentUser().id)
            if (
              (!visibleText(projected) && !isImageMessage(projected) && !projected.meta.stickers?.length) ||
              (projected.meta.hidden && projected.meta.hidden.reason !== 'blind')
            )
              continue
            // 必须先确认收件人仍是该房间成员；隐藏占位也绝不能进入群聊。
            try {
              asChannelActor(binding, actor, () => {})
            } catch {
              continue
            }
            const recipient = client instanceof OneBotClient ? actor.externalId : actor.dmChatId
            if (
              previous.some(
                (delivery) =>
                  delivery.contentHash === hash &&
                  delivery.parts.some(
                    (part) => part.accountId === binding.accountId && part.externalChat === recipient,
                  ),
              )
            )
              continue
            const privateSettings = voiceDeliverySettings(binding, projected, this.settings(binding).values, (code) =>
              this.runtime.log(binding.accountId, code),
            )
            const privateText = `${projected.role === 'assistant' && !omitSpeakerPrefix(binding, projected, binding.accountId, accountRow(binding.accountId).config) && privateSettings.personaPrefix && projected.meta.name ? `${projected.meta.name}: ` : ''}${visibleText(projected)}`
            // 投影已完成房间权限检查；图片只发到该收件人的私聊，绝不降级到群。
            const deliverPrivateMedia = async () => {
              if (projected.meta.hidden) return
              const allowed =
                recipient &&
                (!(client instanceof OneBotClient) ||
                  (await client
                    .privateAllowed(actor.externalId, binding.chat, this.settings(binding).values.tempSessionDm)
                    .catch(() => false)))
              if (allowed && recipient) {
                await sendMessageStickers(
                  { ...binding, chat: recipient, thread: '', scope: 'private' },
                  {
                    ...projected,
                    meta: { ...projected.meta, hidden: undefined, visibility: undefined, channel: 'ic' },
                  },
                  client,
                )
                await this.media.deliver(
                  { ...binding, chat: recipient, thread: '', scope: 'private' },
                  {
                    ...projected,
                    meta: { ...projected.meta, channel: 'ic', visibility: undefined, hidden: undefined },
                  },
                  privateSettings,
                  client,
                  binding.accountId,
                )
              } else hint = true
            }
            if (!visibleText(projected)) {
              await deliverPrivateMedia()
              continue
            }
            let externalId: string | undefined
            const privateVoice = async () =>
              this.media.onlyText(
                { ...binding, scope: 'private', chat: recipient!, thread: '' },
                { ...projected, meta: { ...projected.meta, hidden: undefined, visibility: undefined, channel: 'ic' } },
                privateSettings,
                client,
                binding.accountId,
              )
            if (client instanceof OneBotClient) {
              if (
                await client
                  .privateAllowed(actor.externalId, binding.chat, this.settings(binding).values.tempSessionDm)
                  .catch(() => false)
              ) {
                const replacement = await privateVoice()
                const sent =
                  replacement === ''
                    ? { message_id: 0 }
                    : await client
                        .send(
                          actor.externalId,
                          [{ type: 'text', data: { text: replacement ?? privateText } }],
                          'private',
                          this.settings(binding).values.tempSessionDm
                            ? { group_id: Number(binding.chat.slice(1)) }
                            : {},
                        )
                        .catch(() => {
                          hint = true
                        })
                if (sent) externalId = String(sent.message_id)
              } else hint = true
            } else if (actor.dmChatId) {
              const replacement = await privateVoice()
              const sent =
                replacement === ''
                  ? { message_id: 0 }
                  : await client.serialized(actor.dmChatId, () =>
                      client.call<{ message_id: number }>('sendMessage', {
                        chat_id: actor.dmChatId!,
                        text: replacement ?? privateText,
                      }),
                    )
              externalId = String(sent.message_id)
            } else hint = true
            await deliverPrivateMedia()
            if (externalId && recipient) {
              parts.push({ accountId: binding.accountId, externalChat: recipient, externalId })
              const old = previous.find((delivery) => delivery.bindingId === binding.id)
              const delivery = {
                id: old?.id ?? newId(),
                bindingId: binding.id,
                messageId: message.id,
                contentHash: hash,
                parts,
                status: 'committed' as const,
              }
              // 成功收件人即时落库；重放、多个房间绑定和部分失败重试都不能重复私发。
              db.insert(channelDeliveries)
                .values(delivery)
                .onConflictDoUpdate({
                  target: channelDeliveries.id,
                  set: { parts, contentHash: hash, status: 'committed' },
                })
                .run()
              if (!old) previous.push({ ...delivery, revision: 0 })
            }
          }
          if (hint && binding.scope === 'group')
            await this.send(
              binding.accountId,
              binding.chat,
              client instanceof OneBotClient
                ? t('请先私聊我一次')
                : `${t('请先私聊我一次')} https://t.me/${accountRow(binding.accountId).botUsername}?start=private`,
            )
        })
      this.privateDeliveryTails.set(key, pending)
      try {
        await pending
      } finally {
        if (this.privateDeliveryTails.get(key) === pending) this.privateDeliveryTails.delete(key)
      }
      return
    }
    if (message.meta.stickers?.length) {
      stream?.abort()
      await sendMessageStickers(binding, message, entry.client)
      return
    }
    if (isImageMessage(message) && !visibleText(message)) {
      stream?.abort()
      await this.media.deliver(binding, message, this.settings(binding).values, entry.client, binding.accountId)
      return
    }
    if (entry.client instanceof OneBotClient) {
      stream?.abort()
      const mapped = message.speakerId ? binding.speakers[message.speakerId] : undefined
      const candidate = mapped ? this.runtime.accounts.get(mapped)?.client : undefined
      await this.deliverOneBot(
        candidate instanceof OneBotClient ? { ...binding, accountId: mapped! } : binding,
        message,
        candidate instanceof OneBotClient ? candidate : entry.client,
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
    const nativeIdentity = omitSpeakerPrefix(binding, message, sendingAccountId, identity)
    const identityName = nativeIdentity && message.speakerId ? this.host.getCharacter(message.speakerId).name : null
    const settings = voiceDeliverySettings(binding, message, this.settings(binding).values, (code) =>
      this.runtime.log(binding.accountId, code),
    )
    if (
      message.role === 'user' &&
      (!settings.mirrorWebMessages ||
        String(message.meta.clientMessageId ?? '').startsWith(`${accountRow(binding.accountId).config.provider}:`))
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
    const visible = visibleText(message)
    const text = `${!nativeIdentity && settings.personaPrefix && message.meta.name ? `${message.meta.name}: ` : ''}${visible}`
    if (!text) {
      stream?.abort()
      await this.media
        .deliver(binding, message, settings, entry.client, sendingAccountId, nativeIdentity)
        .catch(() => this.runtime.log(sendingAccountId, 'media.failed'))
      return
    }
    const contentHash = createHash('sha256')
      .update(
        JSON.stringify([
          text,
          settings.thinking === 'fold' ? message.meta.reasoning : '',
          settings.voice,
          settings.voiceNarration,
          settings.voiceLongText,
          settings.voiceMaxChars,
          sendingAccountId,
          message.meta.stage?.choices ?? [],
        ]),
      )
      .digest('hex')
    if (previous?.messageId === message.id && previous.contentHash === contentHash) {
      stream?.abort()
      await this.media
        .deliver(binding, message, settings, entry.client, sendingAccountId, nativeIdentity)
        .catch(() => this.runtime.log(sendingAccountId, 'media.failed'))
      return
    }
    const revision = (previous?.revision ?? -1) + 1
    const choices = message.role === 'assistant' && !isImageMessage(message) ? (message.meta.stage?.choices ?? []) : []
    const rows: ({ text: string; callback_data: string } | MiniAppButton)[][] = []
    for (const [index, choice] of choices.entries())
      rows.push([{ text: choice.text, callback_data: this.token(binding, message, revision, 'choice', { index }) }])
    if (message.role === 'assistant' && !isImageMessage(message)) {
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
    if (vnButton && message.role === 'assistant' && !isImageMessage(message)) rows.push([vnButton])
    const segments: TelegramSegment[] = []
    if (settings.thinking === 'fold' && message.meta.reasoning)
      segments.push({ kind: 'thinking', text: message.meta.reasoning })
    const stage =
      message.role === 'assistant'
        ? parseStageMessage(visibleContent(message), { knownNames: [], vars: {}, inline: false, mvu: false }).stage
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
          if (settings.personaPrefix && stageMembers(binding.chatId).length > 1 && beat.speaker !== identityName)
            segments.push({ kind: 'speaker', text: `${beat.speaker}: ` })
          segments.push(...inlineTelegramSegments(`${beat.text}\n`))
        }
        if (beat.kind === 'narration') segments.push(...inlineTelegramSegments(`${beat.text}\n`))
      }
    } else segments.push(...inlineTelegramSegments(visible))
    const replacement = await this.media.onlyText(
      binding,
      message,
      settings,
      entry.client,
      sendingAccountId,
      nativeIdentity,
    )
    if (replacement !== undefined) {
      stream?.abort()
      stream = undefined
      segments.length = 0
      if (replacement || rows.length) segments.push(...inlineTelegramSegments(replacement || t('操作')))
    }
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
          const old = settings.voice === 'only' ? undefined : previous?.parts[index]
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
  async syncOneBotCard(binding: ChannelBindingDTO) {
    const client = this.runtime.accounts.get(binding.accountId)?.client
    if (
      !(client instanceof OneBotClient) ||
      !client.selfId ||
      binding.scope !== 'group' ||
      !this.settings(binding).values.groupCard
    )
      return
    const chat = this.host.getChatInfo(binding.chatId).chat
    if (!chat.characterId) return
    try {
      await client.groupCard(binding.chat.replace(/^-/, ''), this.host.getCharacter(chat.characterId).name)
    } catch {
      this.runtime.log(binding.accountId, 'onebot.card.failed')
    }
  }
  private numberedChoiceMessage(binding: ChannelBindingDTO) {
    // 场外文字或骰子不应遮住仍可投票的最新公开助手消息。
    return this.host
      .getChatInfo(binding.chatId, 1000)
      .messages.filter(
        (message) =>
          message.role === 'assistant' &&
          !message.meta.hidden &&
          message.meta.channel !== 'whisper' &&
          (!message.meta.visibility || message.meta.visibility.level === 'public'),
      )
      .at(-1)
  }
  private clearNumberedMenu(bindingId: string, actor: string) {
    db.delete(channelActions)
      .where(
        and(
          eq(channelActions.bindingId, bindingId),
          eq(channelActions.allowedActor, actor),
          eq(channelActions.action, 'chat'),
        ),
      )
      .run()
  }
  private async chooseNumber(binding: ChannelBindingDTO, actor: ChannelActorDTO, number: number) {
    asChannelActor(binding, actor, () => {})
    if (!Number.isSafeInteger(number) || number < 1) throw refused()
    const menu = db
      .select()
      .from(channelActions)
      .where(
        and(
          eq(channelActions.bindingId, binding.id),
          eq(channelActions.action, 'chat'),
          eq(channelActions.allowedActor, actor.externalId),
        ),
      )
      .all()
      .filter((item) => item.expiresAt > Date.now())
    if (menu.length) {
      const action = menu[number - 1]
      if (!action) throw refused()
      await this.callback(binding.accountId, {
        type: 'callback',
        id: '',
        dedupeKey: '',
        data: action.token,
        from: { id: Number(actor.externalId), first_name: actor.displayName },
        message: { message_id: 0, chat: { id: Number(binding.chat), type: binding.scope }, entities: [] },
      })
      this.clearNumberedMenu(binding.id, actor.externalId)
      return
    }
    const last = this.numberedChoiceMessage(binding)
    if (!last) throw refused()
    const choices = last.meta.stage?.choices
    const choice = choices?.[number - 1]
    if (!choice) throw refused()
    if (binding.roomId)
      return asChannelActor(binding, actor, () => pickRoomChoice(binding.roomId!, last.id, number - 1))
    const check = choice.check ? this.host.performCheck(binding.chatId, choice.check) : undefined
    return this.generate(binding, { mode: 'send', text: choice.text, images: [], ...(check ? { check } : {}) })
  }
  private async oneBotPoke(id: string, raw: Record<string, unknown>, client: OneBotClient) {
    const group = raw.group_id ? `-${raw.group_id}` : ''
    const actorId = String(raw.user_id)
    const actor = db
      .select()
      .from(channelActors)
      .where(and(eq(channelActors.provider, 'onebot11'), eq(channelActors.externalId, actorId)))
      .get()
    if (!actor || actor.role === 'blocked' || !actor.accountIds.includes(id)) return
    const binding = matchChannelBinding(listBindings(id), {
      scope: group ? 'group' : 'private',
      chat: group || actorId,
      actor: actorId,
    })
    if (binding?.state !== 'active') return
    asChannelActor(binding, actor, () => {})
    const settings = this.settings(binding).values
    if ((!settings.pokeBack && !settings.pokeToStory) || !socialBudget(id, `poke:${group}:${actorId}`, settings)) return
    if (settings.pokeBack && client.napcat)
      await client
        .action(group ? 'group_poke' : 'friend_poke', {
          user_id: Number(actorId),
          ...(group ? { group_id: Number(raw.group_id) } : {}),
        })
        .catch(() => this.runtime.log(id, 'onebot.poke.failed'))
    if (settings.pokeToStory) {
      const event = decodeOneBot(
        {
          post_type: 'message',
          message_type: group ? 'group' : 'private',
          group_id: raw.group_id,
          message_id: -(Number(raw.time) || Date.now()),
          user_id: Number(actorId),
          sender: { nickname: actor.displayName },
          message: [{ type: 'text', data: { text: `*${actor.displayName} pokes you*` } }],
        },
        client,
      )
      if (event) await this.acceptInput(binding, actor, event, [])
    }
  }
  private async deliverOneBotTurn(binding: ChannelBindingDTO, turn: MessageDTO[]) {
    const client = this.runtime.accounts.get(binding.accountId)?.client
    if (!(client instanceof OneBotClient) || bindingRow(binding.id).state !== 'active') return
    if (
      ['only', 'decide', 'button'].includes(this.settings(binding).values.voice) ||
      turn.some(isImageMessage) ||
      turn.length < 2 ||
      new Set(turn.map((message) => message.speakerId ?? message.meta.name)).size < 2
    ) {
      for (const message of turn) await this.deliver(binding, message)
      return
    }
    const settings = this.settings(binding).values
    try {
      const nodes = turn.map((message) => {
        const name =
          message.meta.name ?? (message.speakerId ? this.host.getCharacter(message.speakerId).name : client.nickname)
        const choices = message.meta.stage?.choices?.map((choice, index) => `${index + 1}. ${choice.text}`).join('\n')
        const text = visibleText(message)
        return { name, text: `${text}${choices ? `\n${choices}` : ''}` }
      })
      const sent = await client.forward(binding.chat.replace(/^-/, ''), nodes)
      for (const message of turn) {
        db.insert(channelDeliveries)
          .values({
            id: newId(),
            bindingId: binding.id,
            messageId: message.id,
            revision: 0,
            status: 'committed',
            contentHash: createHash('sha256').update(message.content).digest('hex'),
            parts: [{ accountId: binding.accountId, externalChat: binding.chat, externalId: String(sent.message_id) }],
          })
          .run()
        await this.media.deliver(
          binding,
          message,
          { ...settings, statusCard: settings.statusCard === 'pinned' ? 'every' : settings.statusCard },
          client,
          binding.accountId,
        )
      }
    } catch {
      this.runtime.log(binding.accountId, 'onebot.forward.fallback')
      for (const message of turn) await this.deliver(binding, message)
    }
  }
  private async deliverOneBot(binding: ChannelBindingDTO, message: MessageDTO, client: OneBotClient) {
    const settings = voiceDeliverySettings(binding, message, this.settings(binding).values, (code) =>
      this.runtime.log(binding.accountId, code),
    )
    if (
      message.role === 'user' &&
      (!settings.mirrorWebMessages || String(message.meta.clientMessageId ?? '').startsWith('onebot11:'))
    )
      return
    if (!['assistant', 'user', 'system'].includes(message.role)) return
    const stage = parseStageMessage(visibleContent(message), {
      knownNames: [],
      vars: {},
      inline: false,
      mvu: false,
    }).stage
    const identity = accountRow(binding.accountId).config
    const ownName =
      omitSpeakerPrefix(binding, message, binding.accountId, identity) && message.speakerId
        ? this.host.getCharacter(message.speakerId).name
        : undefined
    const native = omitSpeakerPrefix(binding, message, binding.accountId, identity)
    const visible = visibleText(message)
    let text = visible
    const nodes: { name: string; text: string }[] = []
    if (stage.beats.some((beat) => beat.kind === 'line')) {
      text = stage.beats
        .map((beat) => {
          if (beat.kind === 'line') {
            nodes.push({ name: beat.speaker, text: beat.text })
            return `${settings.personaPrefix && stageMembers(binding.chatId).length > 1 && beat.speaker !== ownName ? `${beat.speaker}: ` : ''}${beat.text}`
          }
          return beat.kind === 'narration' ? beat.text : ''
        })
        .filter(Boolean)
        .join('\n')
    } else if (!native && settings.personaPrefix && message.meta.name) text = `${message.meta.name}: ${text}`
    const choices = message.role === 'assistant' && !isImageMessage(message) ? message.meta.stage?.choices : undefined
    const bodyText = text
    if (choices?.length) text += `\n${choices.map((choice, index) => `${index + 1}. ${choice.text}`).join('\n')}`
    if (message.role === 'assistant' && !isImageMessage(message) && settings.controlsFooter)
      text += `\n${t('回复 /regen 重来，/swipe 换一个')}`
    const hash = createHash('sha256')
      .update(
        JSON.stringify([text, settings.voice, settings.voiceNarration, settings.voiceLongText, settings.voiceMaxChars]),
      )
      .digest('hex')
    const previous = db
      .select()
      .from(channelDeliveries)
      .where(and(eq(channelDeliveries.bindingId, binding.id), eq(channelDeliveries.messageId, message.id)))
      .get()
    if (previous?.contentHash === hash) {
      await this.media.deliver(binding, message, settings, client, binding.accountId, native)
      return
    }
    const parts: { accountId: string; externalChat: string; externalId: string }[] = []
    const replacement = await this.media.onlyText(binding, message, settings, client, binding.accountId, native)
    if (replacement !== undefined) text = `${replacement}${text.slice(bodyText.length)}`.trim()
    let forwarded = false
    if (
      replacement === undefined &&
      binding.scope === 'group' &&
      settings.multiSpeaker === 'forward' &&
      new Set(nodes.map((node) => node.name)).size > 1
    ) {
      try {
        const sent = await client.forward(binding.chat.replace(/^-/, ''), nodes)
        parts.push({ accountId: binding.accountId, externalChat: binding.chat, externalId: String(sent.message_id) })
        forwarded = true
        if (choices?.length)
          await this.send(
            binding.accountId,
            binding.chat,
            choices.map((choice, index) => `${index + 1}. ${choice.text}`).join('\n'),
          )
      } catch {
        this.runtime.log(binding.accountId, 'onebot.forward.fallback')
      }
    }
    if (!forwarded)
      for (const page of splitOneBot(text, settings.maxMessageLength)) {
        const trigger = this.triggers.get(binding.id)
        const sent = await client.send(
          binding.chat.replace(/^-/, ''),
          [
            ...(binding.scope === 'group' && trigger ? [{ type: 'reply', data: { id: String(trigger) } }] : []),
            { type: 'text', data: { text: page } },
          ],
          binding.scope,
        )
        parts.push({ accountId: binding.accountId, externalChat: binding.chat, externalId: String(sent.message_id) })
      }
    db.insert(channelDeliveries)
      .values({
        id: previous?.id ?? newId(),
        bindingId: binding.id,
        messageId: message.id,
        revision: (previous?.revision ?? -1) + 1,
        parts,
        status: 'committed',
        contentHash: hash,
      })
      .onConflictDoUpdate({
        target: channelDeliveries.id,
        set: { parts, contentHash: hash, revision: (previous?.revision ?? -1) + 1 },
      })
      .run()
    await this.media.deliver(
      binding,
      message,
      { ...settings, statusCard: settings.statusCard === 'pinned' ? 'every' : settings.statusCard },
      client,
      binding.accountId,
      native,
    )
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
    if (
      event.type === 'message:saved' &&
      (event.message.meta.imageGen || event.message.meta.images?.length || event.message.meta.stickers?.length)
    ) {
      for (const binding of listBindings().filter((b) => b.chatId === event.message.chatId && b.state === 'active'))
        void this.deliver(binding, event.message).catch(() => {})
    }
    if (event.type === 'message:updated') {
      for (const binding of listBindings().filter((b) => b.chatId === event.message.chatId && b.state === 'active')) {
        if (
          getChatRow(binding.chatId).activeLeafId !== event.message.id &&
          !isImageMessage(event.message) &&
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
              isImageMessage(event.message) ||
              event.message.meta.cg
            )
              void this.deliver(binding, event.message).catch(() => {})
          }, this.settings(binding).values.streamIntervalMs),
        )
      }
    }
  }
}
