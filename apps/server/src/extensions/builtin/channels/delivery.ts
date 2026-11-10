import { createHash } from 'node:crypto'
import { burstDelays, burstSeed, splitBurst } from '@nobot/core'
import { parseStageMessage } from '@nobot/core/stage'
import type { ChannelBindingDTO, MessageDTO } from '@nobot/shared'
import { and, eq } from 'drizzle-orm'
import { db, newId } from '../../../db/client'
import { channelActors, channelBindings, channelDeliveries, messages } from '../../../db/schema'
import { t } from '../../../i18n'
import { getChatRow, loadPath } from '../../../services/chats'
import { stageMembers } from '../../../services/generation/stage'
import { roomMessage } from '../../../services/rooms/dto'
import { currentUser } from '../../../user-context'
import type { ChannelSendError } from '../../types'
import { OneBotClient, splitOneBot } from './adapters/onebot11/client'
import { PluginChannelClient } from './adapters/plugin'
import { inlineTelegramSegments, renderTelegram, type TelegramSegment } from './adapters/telegram/render'
import type { TelegramStream } from './adapters/telegram/stream'
import { type MiniAppButton, miniAppButton } from './miniapp'
import { asChannelActor } from './rooms'
import type { ChannelService } from './service'
import { ownerDirect, suppressChannelRelay } from './service'
import { omitSpeakerPrefix } from './speaker-prefix'
import { sendMessageStickers } from './sticker-delivery'
import { accountRow, bindingRow } from './store'
import { isImageMessage, visibleContent, visibleText } from './visible-text'
import { reserveVoice, voiceDeliverySettings } from './voice-decision'

export class ChannelDelivery {
  private privateDeliveryTails = new Map<string, Promise<unknown>>()
  constructor(private readonly service: ChannelService) {}
  async deliver(binding: ChannelBindingDTO, message: MessageDTO, stream?: TelegramStream) {
    if (suppressChannelRelay(message) || !this.service.routesTo(binding, message)) {
      stream?.abort()
      return
    }
    // OneBot 的多角色转发尚未发出时，先排入前面的正文，再排工具媒体。
    if (isImageMessage(message) || message.meta.stickers?.length || message.meta.channelVoice?.text) {
      const turn = this.service.oneBotTurns.get(binding.id)
      this.service.oneBotTurns.delete(binding.id)
      for (const previous of turn ?? []) void this.deliver(binding, previous).catch(() => {})
    }
    const key = binding.id
    const pending = (this.service.deliveryTails.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.deliverNow(binding, message, stream))
    this.service.deliveryTails.set(key, pending)
    if (
      this.service.inboundScope.getStore()?.accountId === binding.accountId &&
      this.service.runtime.accounts.get(binding.accountId)?.client instanceof PluginChannelClient
    ) {
      // 切换备选等命令也只等待投递入队，不能阻塞接收器释放浏览器锁。
      void pending
        .catch(() => this.service.runtime.log(binding.accountId, 'delivery.failed'))
        .finally(() => {
          if (this.service.deliveryTails.get(key) === pending) this.service.deliveryTails.delete(key)
        })
      return
    }
    try {
      await pending
    } finally {
      if (this.service.deliveryTails.get(key) === pending) this.service.deliveryTails.delete(key)
    }
  }

  /**
   * 分条发送的「还要不要接着发」：绑定仍在用、消息没被删、正文没被改、仍在当前分支上（重新生成或切换备选后就停）。
   * 只比正文不比整行：翻译、语音等扩展会在发送期间往 meta 里写东西，不能因此中断
   */
  private burstGuard(binding: ChannelBindingDTO, message: MessageDTO) {
    return () => {
      const current = db.select().from(channelBindings).where(eq(channelBindings.id, binding.id)).get()
      const row = db.select().from(messages).where(eq(messages.id, message.id)).get()
      if (current?.state !== 'active' || current.chatId !== binding.chatId || row?.content !== message.content)
        return false
      try {
        return loadPath(getChatRow(binding.chatId).activeLeafId).some((item) => item.id === message.id)
      } catch {
        return false
      }
    }
  }

  /** 每次发送成功立即落库，让删除和撤回能定位已经发出的分页。 */
  private recordBurst(
    id: string,
    binding: ChannelBindingDTO,
    message: MessageDTO,
    revision: number,
    contentHash: string,
    parts: { accountId: string; externalChat: string; externalId: string }[],
  ) {
    db.insert(channelDeliveries)
      .values({ id, bindingId: binding.id, messageId: message.id, revision, contentHash, parts, status: 'committed' })
      .onConflictDoUpdate({ target: channelDeliveries.id, set: { parts, contentHash, revision, status: 'committed' } })
      .run()
  }

  private async deliverNow(binding: ChannelBindingDTO, message: MessageDTO, stream?: TelegramStream) {
    if (suppressChannelRelay(message) || !this.service.routesTo(binding, message)) {
      stream?.abort()
      return
    }
    binding = bindingRow(binding.id)
    const burstCurrent = this.burstGuard(binding, message)
    let entry = this.service.runtime.accounts.get(binding.accountId)
    if (!entry || binding.state !== 'active' || message.chatId !== binding.chatId) {
      // 绑定切换会话后，旧生成订阅的迟到结果不能进入新位置。
      stream?.abort()
      return
    }
    if (entry.client instanceof PluginChannelClient) {
      stream?.abort()
      if (
        !entry.client.definition.canInitiate &&
        !ownerDirect(binding) &&
        !this.service.isInboundReply(binding, message)
      ) {
        this.service.runtime.log(binding.accountId, 'delivery.skipped.no-initiate')
        return
      }
      if (
        message.meta.hidden ||
        (message.meta.visibility && message.meta.visibility.level !== 'public') ||
        message.meta.channel === 'whisper'
      )
        return
      await this.deliverPlugin(binding, message, entry.client)
      // CG 图片可能在文字投递后才补齐，媒体去重必须独立于文字回执。
      if (
        isImageMessage(message) &&
        entry.client.definition.media.outboundImages &&
        entry.client.definition.sendImage
      ) {
        await this.service.media
          .deliver(binding, message, this.service.settings(binding).values, entry.client, binding.accountId)
          .catch(() => this.service.runtime.log(binding.accountId, 'media.failed'))
      }
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
            const privateSettings = voiceDeliverySettings(
              binding,
              projected,
              this.service.settings(binding).values,
              (code) => this.service.runtime.log(binding.accountId, code),
            )
            const privateText = `${projected.role === 'assistant' && !omitSpeakerPrefix(binding, projected, binding.accountId, accountRow(binding.accountId).config) && privateSettings.personaPrefix && projected.meta.name ? `${projected.meta.name}: ` : ''}${visibleText(projected)}`
            // 投影已完成房间权限检查；图片只发到该收件人的私聊，绝不降级到群。
            const deliverPrivateMedia = async () => {
              if (projected.meta.hidden) return
              const allowed =
                recipient &&
                (!(client instanceof OneBotClient) ||
                  (await client
                    .privateAllowed(actor.externalId, binding.chat, this.service.settings(binding).values.tempSessionDm)
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
                await this.service.media.deliver(
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
              this.service.media.onlyText(
                { ...binding, scope: 'private', chat: recipient!, thread: '' },
                { ...projected, meta: { ...projected.meta, hidden: undefined, visibility: undefined, channel: 'ic' } },
                privateSettings,
                client,
                binding.accountId,
              )
            if (client instanceof OneBotClient) {
              if (
                await client
                  .privateAllowed(actor.externalId, binding.chat, this.service.settings(binding).values.tempSessionDm)
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
                          this.service.settings(binding).values.tempSessionDm
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
            await this.service.send(
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
    if (message.role === 'tool' && message.meta.channelVoice?.text) {
      stream?.abort()
      const voice = message.meta.channelVoice
      const text = message.meta.channelVoice.text
      if (!voice.bindingIds.includes(binding.id)) return
      const previous = db
        .select()
        .from(channelDeliveries)
        .where(and(eq(channelDeliveries.bindingId, binding.id), eq(channelDeliveries.messageId, message.id)))
        .get()
      if (previous) return
      const settings = this.service.settings(binding).values
      // 工具消息入库后才有稳定 ID，重放同一消息不会重复占用额度。
      const reserved = reserveVoice(binding.id, settings.voiceDecideHourlyMax, message.id)
      if (!reserved) this.service.runtime.log(binding.accountId, 'media.voice.capped')
      const parts: { accountId: string; externalChat: string; externalId: string }[] = []
      const error = reserved
        ? await this.service.media.speak(
            binding,
            message,
            entry.client,
            binding.accountId,
            false,
            {
              ...settings,
              voice: 'only',
              voiceDecisionSpeaker: message.speakerId ?? undefined,
            },
            (externalId) => {
              parts.push({ accountId: binding.accountId, externalChat: binding.chat, externalId })
            },
          )
        : true
      if (error) {
        const sent = await entry.client.call<{ message_id: number }>('sendMessage', {
          chat_id: binding.chat,
          message_thread_id: binding.thread || undefined,
          text,
        })
        parts.push({ accountId: binding.accountId, externalChat: binding.chat, externalId: String(sent.message_id) })
      }
      this.recordBurst(newId(), binding, message, 0, createHash('sha256').update(text).digest('hex'), parts)
      return
    }
    if (message.meta.stickers?.length) {
      stream?.abort()
      await sendMessageStickers(binding, message, entry.client)
      return
    }
    if (isImageMessage(message) && !visibleText(message)) {
      stream?.abort()
      await this.service.media.deliver(
        binding,
        message,
        this.service.settings(binding).values,
        entry.client,
        binding.accountId,
      )
      return
    }
    if (entry.client instanceof OneBotClient) {
      stream?.abort()
      const mapped = message.speakerId ? binding.speakers[message.speakerId] : undefined
      const candidate = mapped ? this.service.runtime.accounts.get(mapped)?.client : undefined
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
      const candidate = this.service.runtime.accounts.get(speakerAccount)
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
    const identityName =
      nativeIdentity && message.speakerId ? this.service.host.getCharacter(message.speakerId).name : null
    const settings = voiceDeliverySettings(binding, message, this.service.settings(binding).values, (code) =>
      this.service.runtime.log(binding.accountId, code),
    )
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
      await this.service.media
        .deliver(binding, message, settings, entry.client, sendingAccountId, nativeIdentity)
        .catch(() => this.service.runtime.log(sendingAccountId, 'media.failed'))
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
      await this.service.media
        .deliver(binding, message, settings, entry.client, sendingAccountId, nativeIdentity)
        .catch(() => this.service.runtime.log(sendingAccountId, 'media.failed'))
      return
    }
    const revision = (previous?.revision ?? -1) + 1
    const choices = message.role === 'assistant' && !isImageMessage(message) ? (message.meta.stage?.choices ?? []) : []
    const rows: ({ text: string; callback_data: string } | MiniAppButton)[][] = []
    for (const [index, choice] of choices.entries())
      rows.push([
        { text: choice.text, callback_data: this.service.token(binding, message, revision, 'choice', { index }) },
      ])
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
            callback_data: this.service.token(binding, message, revision, action!, {}),
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
    const replacement = await this.service.media.onlyText(
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
    const burstText = stage?.beats.some((beat) => beat.kind === 'line')
      ? stage.beats
          .map((beat) => {
            if (beat.kind === 'line')
              return `${settings.personaPrefix && stageMembers(binding.chatId).length > 1 && beat.speaker !== identityName ? `${beat.speaker}: ` : ''}${beat.text}`
            return beat.kind === 'narration' ? beat.text : ''
          })
          .filter(Boolean)
          .join('\n')
      : text
    const burst =
      settings.burst !== 'off' &&
      message.role === 'assistant' &&
      !isImageMessage(message) &&
      !previous &&
      replacement === undefined
        ? splitBurst(burstText, { mode: settings.burst, maxParts: settings.burstMaxParts })
        : []
    const bursting = burst.length > 1
    const deliveryId = previous?.id ?? newId()
    let burstCancelled = false
    if (bursting) {
      stream?.abort()
      stream = undefined
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
      const send = async () => {
        const sentIds: number[] = []
        const delays = burstDelays(burst, { speed: settings.burstSpeed }, burstSeed(message.id))
        const groups = bursting
          ? burst.map((part, index) =>
              renderTelegram([
                ...(index === 0 && settings.thinking === 'fold' && message.meta.reasoning
                  ? [{ kind: 'thinking' as const, text: message.meta.reasoning }]
                  : []),
                ...inlineTelegramSegments(part),
              ]),
            )
          : [renderTelegram(segments)]
        for (const [partIndex, pages] of groups.entries()) {
          if (bursting && partIndex > 0) {
            if (!burstCurrent()) {
              burstCancelled = true
              break
            }
            await sender.client
              .call('sendChatAction', {
                chat_id: binding.chat,
                message_thread_id: binding.thread || undefined,
                action: 'typing',
              })
              .catch(() => {})
            await this.service.sleep(delays[partIndex]!)
            if (!burstCurrent()) {
              burstCancelled = true
              break
            }
          }
          for (const [index, html] of pages.entries()) {
            if (bursting && sentIds.length && !burstCurrent()) {
              burstCancelled = true
              break
            }

            const params = {
              chat_id: binding.chat,
              message_thread_id: binding.thread || undefined,
              text: html,
              parse_mode: 'HTML',
              reply_markup: partIndex === groups.length - 1 && index === pages.length - 1 ? markup : undefined,
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
            if (bursting)
              this.recordBurst(
                deliveryId,
                binding,
                message,
                revision,
                contentHash,
                sentIds.map((id) => ({
                  accountId: sendingAccountId,
                  externalChat: binding.chat,
                  externalId: String(id),
                })),
              )
          }
          if (burstCancelled) break
        }
        return sentIds
      }
      // 拟人等待仅占用绑定自己的投递队列，同群其他话题仍然可以发送。
      ids = bursting ? await send() : await sender.client.serialized(binding.chat, send)
    }
    if (burstCancelled) return
    if (!previous && message.role === 'assistant') {
      const old = deliveries.at(-1)
      if (old)
        for (const part of old.parts)
          await this.service.runtime.accounts
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
        id: deliveryId,
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
    await this.service.media
      .deliver(binding, message, settings, entry.client, sendingAccountId, nativeIdentity)
      .catch(() => this.service.runtime.log(sendingAccountId, 'media.failed'))
  }

  async deliverOneBotTurn(binding: ChannelBindingDTO, turn: MessageDTO[]) {
    turn = turn.filter((message) => this.service.routesTo(binding, message) && !suppressChannelRelay(message))
    if (!turn.length) return
    const client = this.service.runtime.accounts.get(binding.accountId)?.client
    if (!(client instanceof OneBotClient) || bindingRow(binding.id).state !== 'active') return
    if (
      ['only', 'decide', 'button'].includes(this.service.settings(binding).values.voice) ||
      turn.some(isImageMessage) ||
      turn.length < 2 ||
      new Set(turn.map((message) => message.speakerId ?? message.meta.name)).size < 2
    ) {
      for (const message of turn) await this.deliver(binding, message)
      return
    }
    const settings = this.service.settings(binding).values
    try {
      const nodes = turn.map((message) => {
        const name =
          message.meta.name ??
          (message.speakerId ? this.service.host.getCharacter(message.speakerId).name : client.nickname)
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
        await this.service.media.deliver(
          binding,
          message,
          { ...settings, statusCard: settings.statusCard === 'pinned' ? 'every' : settings.statusCard },
          client,
          binding.accountId,
        )
      }
    } catch {
      this.service.runtime.log(binding.accountId, 'onebot.forward.fallback')
      for (const message of turn) await this.deliver(binding, message)
    }
  }

  private async deliverOneBot(binding: ChannelBindingDTO, message: MessageDTO, client: OneBotClient) {
    const burstCurrent = this.burstGuard(binding, message)
    const settings = voiceDeliverySettings(binding, message, this.service.settings(binding).values, (code) =>
      this.service.runtime.log(binding.accountId, code),
    )
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
        ? this.service.host.getCharacter(message.speakerId).name
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
      await this.service.media.deliver(binding, message, settings, client, binding.accountId, native)
      return
    }
    const parts: { accountId: string; externalChat: string; externalId: string }[] = []
    const replacement = await this.service.media.onlyText(binding, message, settings, client, binding.accountId, native)
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
          await this.service.send(
            binding.accountId,
            binding.chat,
            choices.map((choice, index) => `${index + 1}. ${choice.text}`).join('\n'),
          )
      } catch {
        this.service.runtime.log(binding.accountId, 'onebot.forward.fallback')
      }
    }
    const burst =
      settings.burst !== 'off' &&
      message.role === 'assistant' &&
      !isImageMessage(message) &&
      !previous &&
      replacement === undefined &&
      !forwarded
        ? splitBurst(bodyText, { mode: settings.burst, maxParts: settings.burstMaxParts })
        : []
    const bursting = burst.length > 1
    const deliveryId = previous?.id ?? newId()
    if (bursting) burst[burst.length - 1] += text.slice(bodyText.length)
    const delays = burstDelays(burst, { speed: settings.burstSpeed }, burstSeed(message.id))
    // 开了分条但只有一条时用整理后的正文：模型留的空行在 QQ 气泡里只是一大片空白
    const single = burst.length === 1 ? `${burst[0]}${text.slice(bodyText.length)}` : text
    if (!forwarded) {
      for (const [index, part] of (bursting ? burst : [single]).entries()) {
        if (bursting && index > 0) {
          if (!burstCurrent()) return
          await this.service.sleep(delays[index]!)
          if (!burstCurrent()) return
        }
        for (const page of splitOneBot(part, settings.maxMessageLength)) {
          if (bursting && parts.length && !burstCurrent()) return
          const trigger = this.service.triggers.get(binding.id)
          const sent = await client.send(
            binding.chat.replace(/^-/, ''),
            [
              ...(binding.scope === 'group' && trigger && (!bursting || !parts.length)
                ? [{ type: 'reply', data: { id: String(trigger) } }]
                : []),
              { type: 'text', data: { text: page } },
            ],
            binding.scope,
          )
          parts.push({ accountId: binding.accountId, externalChat: binding.chat, externalId: String(sent.message_id) })
          if (bursting) this.recordBurst(deliveryId, binding, message, 0, hash, parts)
        }
      }
    }
    db.insert(channelDeliveries)
      .values({
        id: deliveryId,
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
    await this.service.media.deliver(
      binding,
      message,
      { ...settings, statusCard: settings.statusCard === 'pinned' ? 'every' : settings.statusCard },
      client,
      binding.accountId,
      native,
    )
  }

  private async deliverPlugin(binding: ChannelBindingDTO, message: MessageDTO, client: PluginChannelClient) {
    const previous = db
      .select()
      .from(channelDeliveries)
      .where(and(eq(channelDeliveries.bindingId, binding.id), eq(channelDeliveries.messageId, message.id)))
      .get()
    if (previous) return
    const settings = this.service.settings(binding).values
    const text = message.meta.channelVoice?.text ?? visibleText(message)
    if (!text || !['assistant', 'user', 'tool', 'system'].includes(message.role)) return
    const choices = message.meta.stage?.choices?.map((choice, index) => `${index + 1}. ${choice.text}`).join('\n')
    const body = text + (choices ? `\n${choices}` : '')
    const parts: { accountId: string; externalChat: string; externalId: string }[] = []
    let status: 'committed' | 'uncertain' | 'failed' = 'committed'
    try {
      const burst =
        message.role === 'assistant' && settings.burst !== 'off'
          ? splitBurst(body, { mode: settings.burst, maxParts: settings.burstMaxParts })
          : [body]
      for (const part of burst) {
        // 每页即时保存回执；后续一页失败不能导致先前页重发。
        for (const page of splitOneBot(part, client.definition.limits.maxTextLength)) {
          const sent = await client.call<{ message_id: string }>('sendMessage', { chat_id: binding.chat, text: page })
          parts.push({ accountId: binding.accountId, externalChat: binding.chat, externalId: sent.message_id })
          this.recordBurst(
            `${binding.id}:${message.id}`,
            binding,
            message,
            0,
            createHash('sha256').update(body).digest('hex'),
            parts,
          )
        }
      }
    } catch (error) {
      status =
        (error as Partial<ChannelSendError> | null)?.name === 'ChannelSendError' &&
        (error as Partial<ChannelSendError>).kind === 'not-sent'
          ? 'failed'
          : 'uncertain'
      this.service.logSendError(binding.accountId, error)
    }
    db.insert(channelDeliveries)
      .values({
        id: `${binding.id}:${message.id}`,
        bindingId: binding.id,
        messageId: message.id,
        revision: 0,
        parts,
        status,
        contentHash: createHash('sha256').update(body).digest('hex'),
      })
      .onConflictDoUpdate({ target: channelDeliveries.id, set: { parts, status } })
      .run()
  }
}
