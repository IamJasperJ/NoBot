import { t } from '../../../../../i18n'

export const allowedUpdates = [
  'managed_bot',
  'message',
  'edited_message',
  'callback_query',
  'my_chat_member',
  'chat_member',
  'message_reaction',
]
export type TelegramFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
export interface TelegramMessage {
  message_id: number
  chat: { id: number; type: string }
  text?: string
}
export class TelegramError extends Error {
  constructor(
    readonly code: number,
    readonly retryAfter = 0,
  ) {
    // 平台错误可能回显请求，不保留原始 description 或 URL。
    super(t('渠道请求失败'))
  }
}
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
interface ClientOptions {
  token: string
  baseUrl?: string
  fetch?: TelegramFetch
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}
export class TelegramClient {
  private readonly fetcher: TelegramFetch
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly now: () => number
  private readonly endpoint: string
  private readonly fileEndpoint: string
  private tail: Promise<unknown> = Promise.resolve()
  private nextRequestAt = 0
  private queues = new Map<string, Promise<unknown>>()
  draftSupported = true
  onDraftUnsupported?: () => void
  constructor(options: ClientOptions) {
    this.fetcher = options.fetch ?? fetch
    this.sleep = options.sleep ?? abortableDelay
    this.now = options.now ?? Date.now
    const base = new URL(options.baseUrl ?? 'https://api.telegram.org')
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
      throw new TelegramError(400)
    this.endpoint = `${base.href.replace(/\/$/, '')}/bot${options.token}`
    this.fileEndpoint = `${base.href.replace(/\/$/, '')}/file/bot${options.token}`
  }
  /** 只串行分配发送时隙，长轮询不能占住整个 bot 的发送队列。 */
  private async slot(signal?: AbortSignal) {
    const pending = this.tail
      .catch(() => {})
      .then(async () => {
        await this.sleep(Math.max(0, this.nextRequestAt - this.now()), signal)
        this.nextRequestAt = this.now() + 40
      })
    this.tail = pending
    await pending
  }
  /** 预览原样流式转发，token 只留在服务端，不经过附件缓存。 */
  async streamFile(path: string): Promise<Response> {
    if (path.split('/').some((part) => part === '..') || !/^[a-zA-Z0-9_./-]+$/.test(path)) throw new TelegramError(400)
    const response = await this.fetcher(`${this.fileEndpoint}/${path}`, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new TelegramError(response.status)
    return new Response(response.body, {
      headers: {
        'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }
  async downloadFile(path: string, limit: number): Promise<Uint8Array> {
    if (path.split('/').some((part) => part === '..') || !/^[a-zA-Z0-9_./-]+$/.test(path)) throw new TelegramError(400)
    const response = await this.fetcher(`${this.fileEndpoint}/${path}`, { signal: AbortSignal.timeout(30000) })
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > limit) throw new TelegramError(413)
    const reader = response.body?.getReader()
    if (!reader) throw new TelegramError(400)
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > limit) throw new TelegramError(413)
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return bytes
  }
  async fileDataHint(path: string, signal?: AbortSignal): Promise<string> {
    const response = await this.fetcher(`${this.fileEndpoint}/${path}`, { signal })
    if (!response.ok) throw new TelegramError(response.status)
    const data = await response.arrayBuffer()
    return `data:image/jpeg;base64,${Buffer.from(data).toString('base64')}`
  }
  async call<T = boolean>(
    method: string,
    params: Record<string, unknown> | FormData = {},
    signal?: AbortSignal,
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (signal?.aborted) throw signal.reason
      await this.slot(signal)
      let response: Response
      try {
        response = await this.fetcher(`${this.endpoint}/${method}`, {
          method: 'POST',
          signal,
          ...(params instanceof FormData
            ? { body: params }
            : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) }),
        })
      } catch {
        if (signal?.aborted) throw signal.reason
        throw new TelegramError(503)
      }
      let body: { ok?: boolean; result?: T; error_code?: number; parameters?: { retry_after?: number } }
      try {
        body = (await response.json()) as typeof body
      } catch {
        throw new TelegramError(response.status)
      }
      if (body.ok) return body.result as T
      const code = body.error_code ?? response.status
      const seconds = body.parameters?.retry_after ?? 0
      if (code === 429 && seconds > 0 && seconds <= 300 && attempt < 3) {
        await this.sleep(seconds * 1000, signal)
        continue
      }
      throw new TelegramError(code, seconds)
    }
    throw new TelegramError(503)
  }
  /** 每个位置严格有序；失败不能阻塞后续消息。 */
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
  async poll(options: {
    cursor: number | null
    signal: AbortSignal
    handle: (update: unknown) => Promise<void>
    persist: (cursor: number) => void
  }) {
    let cursor = options.cursor
    let failures = 0
    while (!options.signal.aborted) {
      try {
        const updates = await this.call<{ update_id: number }[]>(
          'getUpdates',
          { offset: cursor === null ? undefined : cursor + 1, timeout: 30, allowed_updates: allowedUpdates },
          options.signal,
        )
        for (const update of updates) {
          if (options.signal.aborted) return
          if (cursor !== null && update.update_id <= cursor) continue
          await options.handle(update)
          // 只有处理成功才推进游标，重启后失败事件仍会重放。
          options.persist(update.update_id)
          cursor = update.update_id
        }
        failures = 0
        if (!updates.length) await this.sleep(50, options.signal)
      } catch {
        if (options.signal.aborted) return
        await this.sleep(Math.min(30000, 500 * 2 ** Math.min(failures++, 6)), options.signal)
      }
    }
  }
}
