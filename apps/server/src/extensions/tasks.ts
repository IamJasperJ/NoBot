import { nextTaskTime } from '@nobot/core'
import {
  type ScheduledTaskDTO,
  type ScheduledTaskInput,
  scheduledTaskInput,
  type TaskSchedule,
  taskScheduleSchema,
} from '@nobot/shared'
import { and, eq, like } from 'drizzle-orm'
import { db, getSetting, newId, setSetting } from '../db/client'
import { settings } from '../db/schema'
import { systemDatabase } from '../db/system-client'
import { extensionBackgrounds } from '../db/system-schema'
import { HttpError, notFound } from '../errors'
import { t } from '../i18n'
import { currentUser, onUserDatabaseClose, runAsUser } from '../user-context'

const prefix = 'scheduled-task:'
const indexId = '$scheduler'
export interface BackgroundTaskDefinition {
  id: string
  name: string
  schedule: TaskSchedule
  misfire?: 'skip' | 'once'
}
export interface BackgroundTasks {
  register(definition: BackgroundTaskDefinition, run: (signal: AbortSignal) => void | Promise<void>): void
}
type Handler = { run: (signal: AbortSignal) => void | Promise<void>; signal: AbortSignal }
type Runtime = {
  timer?: ReturnType<typeof setInterval>
  handlers: Map<string, Handler>
  running: Set<string>
  controllers: Map<string, AbortController>
  stop: AbortController
}
const runtimes = new Map<string, Runtime>()
let trigger: (action: NonNullable<ScheduledTaskDTO['action']>) => void = () => {
  throw new Error('NOT_READY')
}
let busy: (chatId: string) => boolean = () => false
let checkChat: (chatId: string) => void = () => {}
export function setTaskHost(host: { trigger: typeof trigger; busy: typeof busy; checkChat: typeof checkChat }) {
  trigger = host.trigger
  busy = host.busy
  checkChat = host.checkChat
}
export function listScheduledTasks(): ScheduledTaskDTO[] {
  return db
    .select()
    .from(settings)
    .where(like(settings.key, `${prefix}%`))
    .all()
    .map((row) => row.value as ScheduledTaskDTO)
}
function save(task: ScheduledTaskDTO) {
  setSetting(prefix + task.id, task)
}
function get(id: string) {
  const task = getSetting<ScheduledTaskDTO>(prefix + id)
  if (!task) throw notFound(t('定时任务'))
  return task
}
function syncIndex(pending?: ScheduledTaskDTO) {
  const userHandle = currentUser().handle
  if (
    [...listScheduledTasks(), ...(pending ? [pending] : [])].some(
      (task) => task.owner === 'user' && task.enabled && task.nextRunAt !== null,
    )
  ) {
    systemDatabase()
      .insert(extensionBackgrounds)
      .values({ userHandle, extensionId: indexId })
      .onConflictDoNothing()
      .run()
  } else {
    systemDatabase()
      .delete(extensionBackgrounds)
      .where(and(eq(extensionBackgrounds.userHandle, userHandle), eq(extensionBackgrounds.extensionId, indexId)))
      .run()
  }
}
export function startTaskScheduler() {
  const user = currentUser()
  const existing = runtimes.get(user.handle)
  if (existing) return existing
  const runtime: Runtime = {
    handlers: new Map(),
    running: new Set(),
    controllers: new Map(),
    stop: new AbortController(),
  }
  runtimes.set(user.handle, runtime)
  // 执行前已持久化下一轮；进程崩溃后不重放结果不确定的外部动作。
  for (const task of listScheduledTasks()) {
    if (task.status === 'running') save({ ...task, status: 'interrupted', error: 'INTERRUPTED' })
  }
  runtime.timer = setInterval(() => {
    void runAsUser(user, () => tickScheduledTasks(Date.now())).catch(() => {})
  }, 1000)
  runtime.timer.unref()
  return runtime
}
export function stopTaskScheduler(handle: string) {
  const runtime = runtimes.get(handle)
  if (runtime) {
    clearInterval(runtime.timer)
    runtime.stop.abort()
    runtimes.delete(handle)
  }
}
onUserDatabaseClose(stopTaskScheduler)
export function createScheduledTask(input: ScheduledTaskInput, now = Date.now()) {
  const value = scheduledTaskInput.parse(input)
  checkChat(value.action.chatId)
  const task: ScheduledTaskDTO = {
    ...value,
    id: newId(),
    owner: 'user',
    enabled: true,
    nextRunAt: value.schedule.kind === 'once' ? value.schedule.at : nextTaskTime(value.schedule, now),
    lastRunAt: null,
    finishedAt: null,
    status: 'idle',
    error: null,
    runCount: 0,
  }
  // 先建立恢复索引；中途退出最多留下空索引，不会漏掉已保存的任务。
  syncIndex(task)
  save(task)
  startTaskScheduler()
  return task
}
export function setScheduledTaskEnabled(id: string, enabled: boolean, now = Date.now()) {
  const runtime = startTaskScheduler()
  if (enabled && runtime.running.has(id)) throw new HttpError(409, 'TASK_RUNNING', t('任务正在执行'))
  const task = get(id)
  if (!enabled && runtime.running.has(id)) {
    runtime.controllers.get(id)?.abort()
    task.status = 'interrupted'
    task.error = 'CANCELLED'
  }
  task.enabled = enabled
  if (enabled && task.nextRunAt === null)
    task.nextRunAt = task.schedule.kind === 'once' ? now : nextTaskTime(task.schedule, now)
  if (enabled) syncIndex(task)
  save(task)
  if (!enabled) syncIndex()
  return task
}
export function deleteScheduledTask(id: string) {
  const runtime = startTaskScheduler()
  get(id)
  runtime.controllers.get(id)?.abort()
  db.delete(settings)
    .where(eq(settings.key, prefix + id))
    .run()
  runtime.handlers.delete(id)
  syncIndex()
}
export function removeExtensionTasks(owner: string) {
  const runtime = runtimes.get(currentUser().handle)
  for (const task of listScheduledTasks().filter((task) => task.owner === `extension:${owner}`)) {
    db.delete(settings)
      .where(eq(settings.key, prefix + task.id))
      .run()
    runtime?.handlers.delete(task.id)
  }
}
export function backgroundTasks(owner: string, signal: AbortSignal): BackgroundTasks {
  const runtime = startTaskScheduler()
  return {
    register(definition, run) {
      if (signal.aborted) return
      if (!/^[a-z0-9-]+$/.test(definition.id)) throw new Error('INVALID_TASK_ID')
      const schedule = taskScheduleSchema.parse(definition.schedule)
      const id = `${owner}:${definition.id}`
      const old = getSetting<ScheduledTaskDTO>(prefix + id)
      const same = old && JSON.stringify(old.schedule) === JSON.stringify(schedule)
      const task: ScheduledTaskDTO = {
        id,
        owner: `extension:${owner}`,
        name: definition.name,
        schedule,
        misfire: definition.misfire ?? 'skip',
        enabled: old?.enabled ?? true,
        nextRunAt: same ? old.nextRunAt : schedule.kind === 'once' ? schedule.at : nextTaskTime(schedule, Date.now()),
        lastRunAt: old?.lastRunAt ?? null,
        finishedAt: old?.finishedAt ?? null,
        status: old?.status ?? 'idle',
        error: old?.error ?? null,
        runCount: old?.runCount ?? 0,
      }
      save(task)
      const handler = { run, signal }
      runtime.handlers.set(id, handler)
      signal.addEventListener(
        'abort',
        () => {
          if (runtime.handlers.get(id) === handler) runtime.handlers.delete(id)
        },
        { once: true },
      )
    },
  }
}
export async function runScheduledTask(id: string, now = Date.now(), manual = true) {
  const runtime = startTaskScheduler()
  const task = get(id)
  const handler = runtime.handlers.get(id)
  if (runtime.running.has(id)) {
    if (manual) throw new HttpError(409, 'TASK_RUNNING', t('任务正在执行'))
    return task
  }
  if (task.owner !== 'user' && (!handler || handler.signal.aborted)) {
    if (manual) throw new HttpError(409, 'TASK_INACTIVE', t('任务所属扩展未运行'))
    return task
  }
  if (!manual && (!task.enabled || task.nextRunAt === null || task.nextRunAt > now)) return task
  if (!manual && task.misfire === 'skip' && now - task.nextRunAt! > 60000) {
    task.nextRunAt = nextTaskTime(task.schedule, now)
    task.status = 'skipped'
    task.error = 'MISSED'
    save(task)
    syncIndex()
    return task
  }
  if (task.action && busy(task.action.chatId)) {
    task.status = 'deferred'
    task.error = 'CHAT_BUSY'
    task.nextRunAt = now + 15000
    save(task)
    syncIndex()
    return task
  }
  runtime.running.add(id)
  task.status = 'running'
  task.lastRunAt = now
  task.finishedAt = null
  task.error = null
  task.runCount++
  if (!manual || task.schedule.kind === 'once') task.nextRunAt = nextTaskTime(task.schedule, now)
  save(task)
  syncIndex()
  const controller = new AbortController()
  runtime.controllers.set(id, controller)
  const signal = AbortSignal.any([controller.signal, runtime.stop.signal, ...(handler ? [handler.signal] : [])])
  try {
    if (task.action) {
      checkChat(task.action.chatId)
      trigger(task.action)
    } else await handler!.run(signal)
    task.status = signal.aborted ? 'interrupted' : 'succeeded'
  } catch (error) {
    task.status = signal.aborted ? 'interrupted' : 'failed'
    task.error = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'Error'
  } finally {
    runtime.running.delete(id)
    runtime.controllers.delete(id)
    // 关闭用户库或卸载扩展后，旧回调不能写回已删除的状态。
    if (!runtime.stop.signal.aborted && (!handler || runtime.handlers.get(id) === handler) && getSetting(prefix + id)) {
      // 仅合并本次执行结果；调度时间、开关及配置以执行期间的最新记录为准。
      const latest = get(id)
      Object.assign(task, latest, {
        status: task.status,
        error: signal.aborted ? (latest.error ?? task.error) : task.error,
        finishedAt: Date.now(),
      })
      save(task)
    }
  }
  return task
}
export async function tickScheduledTasks(now: number) {
  // 同轮到期任务同时进入各自的运行锁；慢任务不阻塞其他任务，单项拒绝也不影响整轮。
  await Promise.allSettled(
    listScheduledTasks()
      .filter((task) => task.enabled && task.nextRunAt !== null && task.nextRunAt <= now)
      .map((task) => runScheduledTask(task.id, now, false)),
  )
}
