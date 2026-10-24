import { randomBytes } from 'node:crypto'
import { t } from '../../../../../i18n'
import { abortableDelay } from '../telegram/client'

export interface OneBotSocket {
  send(data: string): unknown
  close(code?: number): unknown
}
export interface OneBotDialSocket extends OneBotSocket {
  addEventListener(type: string, handler: (event: { data?: unknown }) => void): void
}
export type OneBotDial = (url: string, token: string) => OneBotDialSocket
export class OneBotError extends Error {
  constructor(readonly retcode: number) {
    // 平台错误常包含原始请求，凭据和消息内容不能进入错误日志。
    super(t('渠道请求失败'))
  }
}
export class OneBotTransport {
  private socket?: OneBotSocket
  private sequence = 0
  private readonly prefix = randomBytes(8).toString('hex')
  private pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  private stopped = false
  private failures = 0
  paused = false
  lastHeartbeatAt: number | null = null
  constructor(
    readonly options: {
      token: string
      timeoutMs?: number
      dial?: OneBotDial
      sleep?: typeof abortableDelay
      onEvent: (event: unknown) => void
      onConnect: () => Promise<void>
      onStatus: (status: 'connecting' | 'online' | 'error') => void
      onBreaker: () => void
    },
  ) {}
  attach(socket: OneBotSocket) {
    this.detach()
    if (this.stopped || this.paused) {
      socket.close(1008)
      return
    }
    this.socket = socket
    void this.options
      .onConnect()
      .then(() => {
        if (this.socket === socket && !this.paused && !this.stopped) this.options.onStatus('online')
      })
      .catch(() => {
        this.options.onStatus('error')
        socket.close(1011)
      })
  }
  receive(raw: unknown) {
    if (this.paused || this.stopped) return
    let data: Record<string, unknown>
    try {
      const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
      data = parsed as Record<string, unknown>
    } catch {
      return
    }
    if ('echo' in data) {
      const key = String(data.echo)
      const pending = this.pending.get(key)
      if (!pending) return
      this.pending.delete(key)
      clearTimeout(pending.timer)
      if (data.status === 'ok' && data.retcode === 0) {
        this.failures = 0
        pending.resolve(data.data)
      } else {
        this.failures++
        const risk = /risk|frozen|blocked|风控|冻结|封禁|频繁/i.test(
          String(data.message ?? '') + String(data.wording ?? ''),
        )
        if (risk || this.failures >= 3) {
          this.paused = true
          this.options.onBreaker()
          this.detach()
        }
        pending.reject(new OneBotError(Number(data.retcode) || -1))
      }
      return
    }
    if (data.post_type === 'meta_event') {
      if (data.meta_event_type === 'heartbeat') {
        this.lastHeartbeatAt = Date.now()
        const status = data.status as { online?: boolean; good?: boolean } | undefined
        this.options.onStatus(status?.online === false || status?.good === false ? 'error' : 'online')
      }
      return
    }
    this.options.onEvent(data)
  }
  call<T = unknown>(action: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (!this.socket || this.paused || this.stopped || signal?.aborted) return Promise.reject(new OneBotError(-1))
    const echo = `${this.prefix}:${++this.sequence}`
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => finish(new OneBotError(-1))
      const finish = (error: Error) => {
        clearTimeout(timer)
        this.pending.delete(echo)
        signal?.removeEventListener('abort', abort)
        reject(error)
      }
      const timer = setTimeout(() => finish(new OneBotError(-2)), this.options.timeoutMs ?? 15000)
      this.pending.set(echo, {
        timer,
        resolve: (data) => {
          signal?.removeEventListener('abort', abort)
          resolve(data)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', abort)
          reject(error)
        },
      })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        this.socket!.send(JSON.stringify({ action, params, echo }))
      } catch {
        finish(new OneBotError(-1))
      }
    }) as Promise<T>
  }
  detach(socket?: OneBotSocket) {
    if (socket && socket !== this.socket) return
    const old = this.socket
    this.socket = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new OneBotError(-1))
    }
    this.pending.clear()
    old?.close()
  }
  stop() {
    this.stopped = true
    this.detach()
  }
  async forward(url: string, signal: AbortSignal) {
    let attempts = 0
    const sleep = this.options.sleep ?? abortableDelay
    const dial =
      this.options.dial ??
      ((endpoint, token) => new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` } }))
    signal.addEventListener('abort', () => this.stop(), { once: true })
    while (!signal.aborted && !this.paused) {
      this.options.onStatus('connecting')
      try {
        await new Promise<void>((resolve) => {
          const socket = dial(url, this.options.token)
          let opened = false
          const connectTimeout = setTimeout(() => {
            socket.close()
            resolve()
          }, 15000)
          const abort = () => {
            socket.close()
            resolve()
          }
          signal.addEventListener('abort', abort, { once: true })
          const close = () => {
            clearTimeout(connectTimeout)
            signal.removeEventListener('abort', abort)
            this.detach(socket)
            resolve()
          }
          socket.addEventListener('open', () => {
            opened = true
            attempts = 0
            clearTimeout(connectTimeout)
            this.attach(socket)
          })
          socket.addEventListener('message', (event) => this.receive(event.data))
          socket.addEventListener('close', close)
          socket.addEventListener('error', () => {
            if (!opened) close()
          })
        })
      } catch {
        this.options.onStatus('error')
      }
      if (!signal.aborted && !this.paused) {
        this.options.onStatus('connecting')
        await sleep(Math.min(30000, 500 * 2 ** Math.min(attempts++, 6)), signal).catch(() => {})
      }
    }
  }
}

/** 默认每账号 20 条/分钟、同聊天至少 1.2 秒并加 0–250ms 抖动；这些是本地预算，不是平台安全承诺。 */
export class OneBotSendQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private sent: number[] = []
  private chats = new Map<string, number>()
  constructor(
    private limits: { perMinute: number; minIntervalMs: number },
    private now = Date.now,
    private sleep = abortableDelay,
    private jitter = () => Math.floor(Math.random() * 251),
  ) {}
  send<T>(chat: string, action: () => Promise<T>, signal?: AbortSignal) {
    const pending = this.tail
      .catch(() => {})
      .then(async () => {
        const now = this.now()
        this.sent = this.sent.filter((at) => now - at < 60000)
        const budgetAt =
          this.sent.length >= this.limits.perMinute ? this.sent[this.sent.length - this.limits.perMinute]! + 60000 : now
        const chatAt = (this.chats.get(chat) ?? -Infinity) + this.limits.minIntervalMs
        await this.sleep(Math.max(0, budgetAt - now, chatAt - now) + this.jitter(), signal)
        this.sent.push(this.now())
        this.chats.set(chat, this.now())
        return action()
      })
    this.tail = pending
    return pending
  }
}
