import { abortableDelay } from '../telegram/client'

/** 最后一次成功值与待写值分开；生成很快结束时要取消尚未执行的忙碌状态。 */
export class OneBotStatus {
  private applied = 0
  private attemptedAt = -Infinity
  private timer?: ReturnType<typeof setTimeout>
  private stopping = false
  constructor(
    private write: (status: number) => Promise<unknown>,
    private options: {
      now?: () => number
      schedule?: typeof setTimeout
      cancel?: typeof clearTimeout
      sleep?: typeof abortableDelay
    } = {},
  ) {}
  private now() {
    return (this.options.now ?? Date.now)()
  }
  clear() {
    if (this.timer) (this.options.cancel ?? clearTimeout)(this.timer)
    this.timer = undefined
  }
  follow(status: 10 | 30 | 50) {
    if (this.stopping) return
    this.clear()
    if (status === this.applied) return
    this.timer = (this.options.schedule ?? setTimeout)(
      () => {
        this.timer = undefined
        this.attemptedAt = this.now()
        // 枚举由 NapCat 文档确认；不尝试会员、自定义或扩展状态。
        // https://napcat.apifox.cn/226658977e0
        void this.write(status)
          .then(() => {
            this.applied = status
          })
          .catch(() => {})
      },
      Math.max(0, this.attemptedAt + 60000 - this.now()),
    )
    this.timer.unref?.()
  }
  async leaving(signal?: AbortSignal) {
    this.stopping = true
    this.clear()
    if (this.applied === 30) return
    await (this.options.sleep ?? abortableDelay)(Math.max(0, this.attemptedAt + 60000 - this.now()), signal)
    this.attemptedAt = this.now()
    await this.write(30)
  }
}
