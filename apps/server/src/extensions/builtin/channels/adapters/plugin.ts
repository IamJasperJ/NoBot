import type { ChannelAccountConfig } from '@nobot/shared'
import {
  type ChannelInboundMessage,
  type ChannelProviderAccount,
  type ChannelProviderDefinition,
  ChannelProviderStoppedError,
} from '../../../types'
import { splitOneBot } from './onebot11/client'
import { abortableDelay } from './telegram/client'
import { decodeTelegram } from './telegram/receive'

/** 单次退避的最长等待；超过就放弃这段，不让整个账号的队列空等。 */
export const maxRetryWaitMs = 10 * 60000

/** 发送队列按账号串行；暂停和退避共享同一队列，未知结果绝不重放。 */
export class PluginChannelClient {
  draftSupported = false
  onDraftUnsupported?: () => void
  readonly files = new Map<string, { bytes: Uint8Array; mime: string }>()
  replayRequest?: (id: string) => Promise<void>
  private tail: Promise<unknown> = Promise.resolve()
  private queues = new Map<string, Promise<unknown>>()
  private sent: number[] = []
  private lastAt = 0
  private paused = true
  private wake?: () => void
  now = Date.now
  sleep = abortableDelay
  constructor(
    readonly definition: ChannelProviderDefinition,
    readonly account: ChannelProviderAccount,
    readonly config: ChannelAccountConfig,
    readonly signal: AbortSignal,
  ) {
    signal.addEventListener('abort', () => this.wake?.(), { once: true })
  }
  check() {
    if (this.signal.aborted) throw new ChannelProviderStoppedError()
  }
  status(status: string) {
    this.paused = status !== 'online'
    if (!this.paused) this.wake?.()
  }
  private async ready() {
    this.check()
    while (this.paused) {
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
      this.check()
    }
  }
  private async send(chatId: string, text: string, replyTo?: string) {
    const limits = this.definition.limits
    const interval = Math.max(this.config.rateLimit.minIntervalMs, limits.minIntervalMs ?? 0)
    const minute = Math.min(this.config.rateLimit.perMinute, limits.perMinute ?? Infinity)
    for (let attempt = 0; ; ) {
      await this.ready()
      const now = this.now()
      this.sent = this.sent.filter((at) => now - at < 60000)
      await this.sleep(
        Math.max(0, this.lastAt + interval - now, this.sent.length >= minute ? this.sent[0]! + 60000 - now : 0),
        this.signal,
      )
      await this.ready()
      this.lastAt = this.now()
      this.sent.push(this.lastAt)
      try {
        return await this.definition.send(this.account, { chatId, text, replyTo }, this.signal)
      } catch (error) {
        this.check()
        const value =
          error && typeof error === 'object'
            ? (error as { name?: unknown; kind?: unknown; retryAfterMs?: unknown })
            : undefined
        if (value?.name === 'ChannelProviderStoppedError') throw new ChannelProviderStoppedError()
        if (value?.name === 'ChannelSendError' && value.kind === 'not-sent') {
          // 验证码等暂停由插件恢复状态，不消耗在线发送的重试预算。
          if (this.paused) {
            await this.ready()
            continue
          }
          // 发送队列按账号串行；等待过久（如某人的每日上限到次日）会堵住其他会话，直接判定未发出。
          if (
            attempt >= 3 ||
            typeof value.retryAfterMs !== 'number' ||
            !Number.isFinite(value.retryAfterMs) ||
            value.retryAfterMs > maxRetryWaitMs
          )
            throw error
          await this.sleep(Math.max(0, value.retryAfterMs), this.signal)
          await this.ready()
          attempt++
        } else throw error
      }
    }
  }
  async call<T = boolean>(
    method: string,
    params: Record<string, unknown> | FormData = {},
    _signal?: AbortSignal,
  ): Promise<T> {
    this.check()
    const args = params instanceof FormData ? Object.fromEntries(params.entries()) : params
    if (method === 'getMe') return { id: this.account.id, is_bot: true, first_name: this.definition.name } as T
    if (method === 'getFile') {
      const id = String(args.file_id)
      return { file_path: id, file_size: this.files.get(id)?.bytes.length } as T
    }
    if (method === 'getChat') return { id: args.chat_id, title: String(args.chat_id) } as T
    if (method !== 'sendMessage') return true as T
    const pending = this.tail
      .catch(() => {})
      .then(async () => {
        const parts: string[] = []
        for (const text of splitOneBot(String(args.text ?? ''), this.definition.limits.maxTextLength)) {
          const result = await this.send(
            String(args.chat_id),
            text,
            typeof args.reply_to_message_id === 'string' ? args.reply_to_message_id : undefined,
          )
          parts.push(result.id)
        }
        return { message_id: parts.at(-1) ?? '', parts }
      })
    this.tail = pending
    return (await pending) as T
  }
  serialized<T>(chat: string, fn: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(chat) ?? Promise.resolve()).catch(() => {}).then(fn)
    this.queues.set(chat, pending)
    void pending
      .finally(() => {
        if (this.queues.get(chat) === pending) this.queues.delete(chat)
      })
      .catch(() => {})
    return pending
  }
  async downloadFile(path: string, limit: number) {
    this.check()
    const file = this.files.get(path)
    if (!file || file.bytes.length > limit) throw new Error('BAD_MEDIA')
    return file.bytes
  }
  async fileDataHint(path: string) {
    const bytes = await this.downloadFile(path, 5 * 1024 * 1024)
    return `data:${this.files.get(path)!.mime};base64,${Buffer.from(bytes).toString('base64')}`
  }
  inbound(message: ChannelInboundMessage, rejected: () => void) {
    this.check()
    const scope = message.chat.scope ?? 'private'
    if (!this.definition.scopes.includes(scope)) return null
    const photo = (message.images ?? []).flatMap((image, index) => {
      if (
        !this.definition.media.inboundImages ||
        index >= 4 ||
        image.bytes.length > 5 * 1024 * 1024 ||
        !/^image\/[a-z0-9.+-]+$/i.test(image.mime)
      ) {
        rejected()
        return []
      }
      const id = crypto.randomUUID()
      this.files.set(id, image)
      return [{ file_id: id, file_size: image.bytes.length, mime_type: image.mime }]
    })
    return {
      update_id: message.id,
      message: {
        message_id: message.id,
        chat: { id: message.chat.id, title: message.chat.title, type: scope },
        from: { id: message.from.id, first_name: message.from.name },
        text: message.text,
        photo: photo.length ? photo : undefined,
        context: message.context,
        sentAt: message.sentAt,
        reply_to_message: message.replyTo ? { message_id: message.replyTo } : undefined,
        // 插件自己判断的 @ 和引用，Telegram 解码会丢掉未知字段，decode 里再从原始对象取回
        mentionsMe: message.mentionsMe,
        repliesToMe: message.repliesToMe,
      },
    }
  }
  decode(input: unknown) {
    const decoded = decodeTelegram(input, { id: this.account.id })
    if (decoded?.type !== 'message') return decoded
    const raw = (input as { message?: { mentionsMe?: unknown; repliesToMe?: unknown } }).message
    decoded.mentionsBot = raw?.mentionsMe === true
    if (typeof raw?.repliesToMe === 'boolean') {
      decoded.repliesToBot = raw.repliesToMe
      return decoded
    }
    // 插件没给 repliesToMe：标记出来，由服务按本账号的投递记录判断引用的是不是自己发的消息
    decoded.repliesToBot = false
    return Object.assign(decoded, { repliesToBotUnknown: true as const })
  }
}
