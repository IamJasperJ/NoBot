import { expect, test } from 'bun:test'
import { applyDirection, directMessage, parseDirections, waitForDirections, waitForVnDirections } from './director'
import type { TtsSegment } from './service'

const segments: TtsSegment[] = [{ speaker: { kind: 'npc', name: 'Alice' }, text: 'Hello!', expression: 'joy' }]
function context(reply: () => Promise<string>) {
  const data = new Map<string, unknown>()
  return {
    storage: {
      get: <T>(key: string) => data.get(key) as T | undefined,
      set: (key: string, value: unknown) => {
        data.set(key, value)
      },
      delete: (key: string) => {
        data.delete(key)
      },
    },
    host: { quietPrompt: reply },
    data,
  }
}
test('导演逐字段宽松校验；篡改原文和过多声音被丢弃', () => {
  expect(parseDirections('[{"i":0,"tone":"invalid","intensity":3,"text":"Hello?<sigh/>"}]', segments)).toEqual([
    { delivery: { intensity: 3 } },
  ])
  expect(parseDirections('[{"i":0,"tone":"sad","text":"<sigh/>Hello!"}]', segments)[0]).toEqual({
    delivery: { tone: 'sad' },
    text: '<sigh/>Hello!',
  })
  expect(parseDirections('[{"i":0,"text":"<sigh/><sigh/><sigh/>Hello!"}]', segments)[0]).not.toHaveProperty('text')
  expect(parseDirections('[null,{"i":4},{"i":0,"direction":5,"volume":"whisper"}]', segments)[0]?.delivery).toEqual({
    volume: 'whisper',
  })
})
test('缓存、内容变化、并发去重和英文提示词', async () => {
  let calls = 0
  const ctx = context(async () => {
    calls++
    return '[{"i":0,"tone":"sad"}]'
  })
  const results = await Promise.all(Array.from({ length: 5 }, () => directMessage(ctx, 'm', 'c', segments)))
  expect(calls).toBe(1)
  expect(results[0]?.[0]?.delivery.tone).toBe('sad')
  await directMessage(ctx, 'm', 'c', segments)
  expect(calls).toBe(1)
  expect([...ctx.data.keys()][0]).toMatch(/^tts-direction:m:[a-f0-9]{64}$/)
  await directMessage(ctx, 'm', 'c', [{ ...segments[0]!, text: 'Changed' }])
  expect(calls).toBe(2)
})
test('超时回退后任务继续缓存；失败只回退', async () => {
  let finish!: (value: string) => void
  const ctx = context(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const task = directMessage(ctx, 'm', 'c', segments)
  expect(await waitForDirections(task, 5)).toBeUndefined()
  finish('[{"i":0,"tone":"calm"}]')
  await task
  expect((await directMessage(ctx, 'm', 'c', segments))[0]?.delivery.tone).toBe('calm')
  const failed = context(async () => 'invalid json')
  expect(await directMessage(failed, 'm', 'c', segments)).toEqual([])
})
test('rich 台词和声音优先，导演保留为单独的低优先级覆盖', () => {
  const segment = { ...segments[0]!, text: '<laugh/>Hello!', delivery: { volume: 'shout' as const } }
  expect(applyDirection(segment, { delivery: { volume: 'whisper', tone: 'sad' }, text: '<sigh/>Hello!' })).toEqual({
    ...segment,
    director: { volume: 'whisper', tone: 'sad' },
  })
})

test('VN 只有首个等待者等待在途导演，后续句子立即回退，完成后可复用', async () => {
  let finish!: (value: number) => void
  const task = new Promise<number>((resolve) => {
    finish = resolve
  })
  const first = waitForVnDirections(task)
  expect(await waitForVnDirections(task)).toBeUndefined()
  finish(42)
  expect(await first).toBe(42)
  expect(await waitForVnDirections(task)).toBe(42)
})

test('导演标注可插入成对语气和停顿，已有的范围、停顿与别名优先', () => {
  const text = '<whisper>Hello</whisper><pause ms="500"/>!'
  expect(parseDirections(JSON.stringify([{ i: 0, text }]), segments)[0]?.text).toBe(text)
  for (const text of ['<whisper>Hello</whisper>!', 'Hello<pause/>!', '[whispers]Hello!']) {
    const segment = { ...segments[0]!, text }
    expect(applyDirection(segment, { delivery: {}, text: '<sigh/>Hello!' }).text).toBe(text)
  }
})
