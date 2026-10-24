import type { TelegramClient, TelegramMessage } from './client'
import { TelegramError } from './client'
import { renderTelegram, type TelegramSegment } from './render'

export class TelegramTextStream {
  private latest = ''
  private reasoning = ''
  private sent = ''
  private messageId: number | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<unknown> = Promise.resolve()
  private started = false
  private closed = false
  private typing: ReturnType<typeof setInterval>
  constructor(
    private client: TelegramClient,
    private ref: { chat: string; private: boolean; thread?: string },
    private options: {
      signal?: AbortSignal
      intervalMs?: number
      draftId: number
      messageId?: number
      accountId?: string
    },
  ) {
    this.messageId = options.messageId
    const activity = () => {
      void client
        .call('sendChatAction', { chat_id: ref.chat, action: 'typing', message_thread_id: ref.thread }, options.signal)
        .catch(() => {})
    }
    activity()
    this.typing = setInterval(activity, 4000)
    this.typing.unref()
    options.signal?.addEventListener('abort', () => this.abort(), { once: true })
  }
  get accountId() {
    return this.options.accountId
  }
  async waitReady() {}
  get isClosed() {
    return this.closed
  }
  update(text: string, reasoning = '') {
    if (this.closed) return
    this.latest = text
    this.reasoning = reasoning
    if (this.timer) return
    const delay = this.started ? (this.options.intervalMs ?? 1500) : 0
    this.started = true
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.pending = this.pending
        .catch(() => {})
        .then(() => this.flush())
        .catch(() => {})
    }, delay)
  }
  private async flush() {
    if (this.closed || !this.latest || this.sent === JSON.stringify([this.latest, this.reasoning])) return
    const text = this.latest
    const signature = JSON.stringify([text, this.reasoning])
    const html = renderTelegram([
      ...(this.reasoning ? [{ kind: 'thinking' as const, text: this.reasoning }] : []),
      { kind: 'text', text },
    ])[0]!
    await this.client.serialized(this.ref.chat, async () => {
      const common = { chat_id: this.ref.chat, message_thread_id: this.ref.thread, text: html, parse_mode: 'HTML' }
      if (this.ref.private && this.client.draftSupported) {
        try {
          await this.client.call('sendMessageDraft', { ...common, draft_id: this.options.draftId }, this.options.signal)
          this.sent = signature
          return
        } catch (error) {
          if (!(error instanceof TelegramError) || ![400, 404].includes(error.code)) throw error
          this.client.draftSupported = false
          this.client.onDraftUnsupported?.()
        }
      }
      if (this.messageId)
        await this.client.call('editMessageText', { ...common, message_id: this.messageId }, this.options.signal)
      else
        this.messageId = (
          await this.client.call<TelegramMessage>('sendMessage', common, this.options.signal)
        ).message_id
      this.sent = signature
    })
  }
  async commit(text: string, replyMarkup?: unknown, segments?: TelegramSegment[]) {
    if (this.closed) return []
    if (this.timer) clearTimeout(this.timer)
    await this.pending.catch(() => {})
    this.closed = true
    clearInterval(this.typing)
    return this.client.serialized(this.ref.chat, async () => {
      const ids: number[] = []
      const pages = renderTelegram(segments ?? [{ kind: 'text', text }])
      for (const [index, html] of pages.entries()) {
        const common = {
          chat_id: this.ref.chat,
          message_thread_id: this.ref.thread,
          text: html,
          parse_mode: 'HTML',
          reply_markup: index === pages.length - 1 ? replyMarkup : undefined,
        }
        if (index === 0 && this.messageId) {
          try {
            await this.client.call('editMessageText', { ...common, message_id: this.messageId }, this.options.signal)
            ids.push(this.messageId)
          } catch {
            if (this.options.signal?.aborted) throw this.options.signal.reason
            const sent = await this.client.call<TelegramMessage>(
              'sendMessage',
              { ...common, reply_parameters: { message_id: this.messageId, allow_sending_without_reply: true } },
              this.options.signal,
            )
            ids.push(sent.message_id)
          }
        } else
          ids.push((await this.client.call<TelegramMessage>('sendMessage', common, this.options.signal)).message_id)
      }
      return ids
    })
  }
  abort() {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    clearInterval(this.typing)
  }
}

export type TelegramStream = Pick<
  TelegramTextStream,
  'update' | 'commit' | 'abort' | 'isClosed' | 'accountId' | 'waitReady'
>

/** 查验另一只 bot 的群成员身份期间先缓存增量，避免先用错误身份发送再切换。 */
export class DeferredTelegramStream implements TelegramStream {
  private stream?: TelegramTextStream
  private closed = false
  private text = ''
  private reasoning = ''
  private ready: Promise<void>
  constructor(open: () => Promise<TelegramTextStream>) {
    this.ready = open().then((stream) => {
      this.stream = stream
      if (this.closed) stream.abort()
      else if (this.text) stream.update(this.text, this.reasoning)
    })
    // 初始化异常由 commit 返回；后台增量期间不制造未处理的拒绝。
    void this.ready.catch(() => {})
  }
  get isClosed() {
    return this.closed || this.stream?.isClosed === true
  }
  get accountId() {
    return this.stream?.accountId
  }
  waitReady() {
    return this.ready
  }
  update(text: string, reasoning = '') {
    if (this.closed) return
    this.text = text
    this.reasoning = reasoning
    this.stream?.update(text, reasoning)
  }
  async commit(text: string, replyMarkup?: unknown, segments?: TelegramSegment[]) {
    await this.ready
    if (this.closed || !this.stream) return []
    return this.stream.commit(text, replyMarkup, segments)
  }
  abort() {
    this.closed = true
    this.stream?.abort()
  }
}
