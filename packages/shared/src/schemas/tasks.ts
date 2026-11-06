import { z } from 'zod'

export const taskScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal('interval'),
    everyMs: z.number().int().min(1000),
    anchor: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('daily'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timeZone: z.string().refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value })
        return true
      } catch {
        return false
      }
    }),
  }),
])
export type TaskSchedule = z.infer<typeof taskScheduleSchema>
export const scheduledTaskInput = z.object({
  name: z.string().trim().min(1).max(200),
  schedule: taskScheduleSchema,
  misfire: z.enum(['skip', 'once']).default('skip'),
  action: z.object({
    chatId: z.string().min(1),
    speakerId: z.string().optional(),
    instruction: z.string().trim().min(1).max(20000),
  }),
})
export type ScheduledTaskInput = z.input<typeof scheduledTaskInput>
export interface ScheduledTaskDTO {
  id: string
  owner: string
  name: string
  schedule: TaskSchedule
  misfire: 'skip' | 'once'
  action?: z.infer<typeof scheduledTaskInput>['action']
  enabled: boolean
  nextRunAt: number | null
  lastRunAt: number | null
  finishedAt: number | null
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'deferred' | 'interrupted'
  /** 固定错误码或异常类型；不保存可能含凭据的异常消息。 */
  error: string | null
  runCount: number
}
export interface ExtensionBackgroundStatus {
  state: 'stopped' | 'running' | 'failed'
  startedAt: number | null
  error: string | null
}
