import type { TaskSchedule } from '@nobot/shared'

/** 严格返回 after 之后的时刻；时间由调用方传入。夏令时缺失时刻跳过，当天重复时刻只取一次。 */
export function nextTaskTime(schedule: TaskSchedule, after: number): number | null {
  if (schedule.kind === 'once') return schedule.at > after ? schedule.at : null
  if (schedule.kind === 'interval') {
    return schedule.anchor > after
      ? schedule.anchor
      : schedule.anchor + (Math.floor((after - schedule.anchor) / schedule.everyMs) + 1) * schedule.everyMs
  }
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: schedule.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts = (at: number) => {
    const p = Object.fromEntries(formatter.formatToParts(at).map((part) => [part.type, part.value]))
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }
  }
  const start = parts(after)
  for (let at = Math.floor(after / 60000) * 60000 + 60000; at <= after + 72 * 3600000; at += 60000) {
    const p = parts(at)
    if (p.time === schedule.time && !(p.date === start.date && start.time >= schedule.time)) return at
  }
  return null
}
