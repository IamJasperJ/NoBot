import { t } from '../../../i18n'
/** 图片接口共用先进先出队列；取消只移除本任务，不中断其他任务。 */
export class Semaphore {
  private running = 0
  private queue: { start: () => void; abort: () => void; position?: (n: number) => void }[] = []
  constructor(private limit: number) {}
  setLimit(limit: number) {
    this.limit = limit
    this.drain()
  }
  private drain() {
    while (this.running < this.limit && this.queue.length) this.queue.shift()?.start()
    this.queue.forEach((entry, index) => {
      entry.position?.(index + 1)
    })
  }
  async run<T>(task: () => Promise<T>, signal?: AbortSignal, position?: (n: number) => void): Promise<T> {
    signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const entry = {
        start: () => {
          signal?.removeEventListener('abort', entry.abort)
          this.running++
          resolve()
        },
        abort: () => {
          this.queue = this.queue.filter((item) => item !== entry)
          reject(new Error(t('已取消')))
          this.drain()
        },
        position,
      }
      signal?.addEventListener('abort', entry.abort, { once: true })
      this.queue.push(entry)
      position?.(this.queue.length)
      this.drain()
    })
    try {
      signal?.throwIfAborted()
      return await task()
    } finally {
      this.running--
      this.drain()
    }
  }
}
