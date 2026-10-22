import type { Semaphore } from '../semaphore'
import type { Snapshot } from './prompt'

export const imageQueues = new Map<string, Semaphore>()
export const tasks = new Map<string, AbortController>()
export const retryLocks = new Set<string>()
export const previews = new Map<string, { expires: number; snapshot: Snapshot }>()
export const backgroundTasks = new Map<string, string>()
