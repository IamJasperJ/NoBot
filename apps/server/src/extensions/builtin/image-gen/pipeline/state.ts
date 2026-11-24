import { HttpError } from '../../../../errors'
import { t } from '../../../../i18n'
import { currentUser } from '../../../../user-context'
import type { Semaphore } from '../semaphore'
import type { Snapshot } from './prompt'

export const imageQueues = new Map<string, Semaphore>()
export const tasks = new Map<string, AbortController>()
export const retryLocks = new Set<string>()
export const previews = new Map<string, { expires: number; snapshot: Snapshot }>()
export const backgroundTasks = new Map<string, string>()

const lifetimes = new Map<string, AbortSignal>()

export function trackImageLifetime(signal: AbortSignal) {
  const handle = currentUser().handle
  const lifetime = new AbortController()
  const stop = () => {
    lifetime.abort(new HttpError(409, 'IMAGE_CANCELLED', t('已取消')))
    if (lifetimes.get(handle) !== lifetime.signal) return
    lifetimes.delete(handle)
    for (const key of previews.keys()) if (key.startsWith(`${handle}:`)) previews.delete(key)
  }
  lifetimes.set(handle, lifetime.signal)
  if (signal.aborted) stop()
  else signal.addEventListener('abort', stop, { once: true })
}

/** 每个任务启动时捕获用户的扩展生命周期，重新启用时不会替换旧任务的信号。 */
export function imageTaskSignal(...signals: (AbortSignal | undefined)[]) {
  return AbortSignal.any([lifetimes.get(currentUser().handle), ...signals].filter((signal) => signal !== undefined))
}
