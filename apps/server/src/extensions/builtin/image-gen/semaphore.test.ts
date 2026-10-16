import { expect, test } from 'bun:test'
import { Semaphore } from './semaphore'

test('上限为 2 时五个任务按先进先出运行，并且全部完成', async () => {
  const semaphore = new Semaphore(2)
  const started: number[] = []
  let running = 0
  let peak = 0
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      semaphore.run(async () => {
        started.push(i)
        running++
        peak = Math.max(peak, running)
        await Bun.sleep(5)
        running--
        return i
      }),
    ),
  )
  expect(peak).toBe(2)
  expect(running).toBe(0)
  expect(started).toEqual([0, 1, 2, 3, 4])
  expect(results).toEqual(started)
})

test('失败释放名额，调整上限后继续处理队列', async () => {
  const semaphore = new Semaphore(1)
  let finish = () => {}
  const first = semaphore.run(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  await Bun.sleep(0)
  const failed = semaphore.run(async () => {
    throw new Error('模拟失败')
  })
  const rejection = failed.catch((error: unknown) => error)
  const last = semaphore.run(async () => '完成')
  semaphore.setLimit(2)
  expect(await rejection).toBeInstanceOf(Error)
  expect(await last).toBe('完成')
  finish()
  await first
})
