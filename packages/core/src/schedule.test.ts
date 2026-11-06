import { expect, test } from 'bun:test'
import { nextTaskTime } from './schedule'

const at = Date.parse
const daily = (time: string, timeZone: string) => ({ kind: 'daily' as const, time, timeZone })
test('一次性与固定间隔严格推进，停机后不逐次补跑', () => {
  expect(nextTaskTime({ kind: 'once', at: 100 }, 99)).toBe(100)
  expect(nextTaskTime({ kind: 'once', at: 100 }, 100)).toBeNull()
  expect(nextTaskTime({ kind: 'interval', everyMs: 1000, anchor: 500 }, 10000)).toBe(10500)
})
test('日任务按用户时区跨午夜，宿主时区不参与计算', () => {
  expect(nextTaskTime(daily('08:00', 'Asia/Shanghai'), at('2026-11-06T00:00:00Z'))).toBe(at('2026-11-07T00:00:00Z'))
  expect(nextTaskTime(daily('08:00', 'Asia/Shanghai'), at('2026-11-05T23:59:00Z'))).toBe(at('2026-11-06T00:00:00Z'))
})
test('夏令时缺失时间跳过，重复时间同一天只执行一次', () => {
  expect(nextTaskTime(daily('02:30', 'America/New_York'), at('2026-03-08T05:00:00Z'))).toBe(at('2026-03-09T06:30:00Z'))
  expect(nextTaskTime(daily('01:30', 'America/New_York'), at('2026-11-01T05:30:00Z'))).toBe(at('2026-11-02T06:30:00Z'))
})
