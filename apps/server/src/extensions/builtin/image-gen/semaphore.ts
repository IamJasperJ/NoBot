interface QueuedTask {
  start: () => void
  reject: (error: unknown) => void
  position?: (n: number) => void
}

/** 图片接口共用先进先出队列；取消只移除本任务，不中断其他任务。 */
export class Semaphore {
  private running = 0
  private queue: QueuedTask[] = []
  constructor(private limit: number) {}
  setLimit(limit: number) {
    this.limit = limit
    this.drain()
  }
  private drain() {
    while (this.running < this.limit && this.queue.length) this.queue.shift()?.start()
    for (let index = 0; index < this.queue.length; ) {
      const entry = this.queue[index]!
      try {
        entry.position?.(index + 1)
        if (this.queue[index] === entry) index++
      } catch (error) {
        // 占位消息可能已删除，失败的回调要释放排队项，避免阻塞后面的任务。
        const position = this.queue.indexOf(entry)
        if (position >= 0) this.queue.splice(position, 1)
        entry.reject(error)
      }
    }
  }
  async run<T>(task: () => Promise<T>, signal?: AbortSignal, position?: (n: number) => void): Promise<T> {
    signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        const index = this.queue.indexOf(entry)
        if (index < 0) return
        this.queue.splice(index, 1)
        entry.reject(signal?.reason)
        this.drain()
      }
      const entry: QueuedTask = {
        start: () => {
          if (signal?.aborted) {
            entry.reject(signal.reason)
            return
          }
          signal?.removeEventListener('abort', cancel)
          this.running++
          resolve()
        },
        reject: (error) => {
          signal?.removeEventListener('abort', cancel)
          reject(error)
        },
        position,
      }
      position?.(this.queue.length + 1)
      signal?.throwIfAborted()
      this.queue.push(entry)
      signal?.addEventListener('abort', cancel, { once: true })
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
