import { expect, test } from 'bun:test'
import type { Beat, MessageMeta } from '@ai-parter/shared'
import { autoAdvanceDelay, currentCg, shownBeatIndexes } from './player-logic'

const beats: Beat[] = [
  { kind: 'stage', ops: [] },
  { kind: 'line', speaker: 'Alice', text: 'Hello' },
  { kind: 'cg', prompt: 'A garden' },
  { kind: 'cg', prompt: 'A river' },
  { kind: 'narration', text: 'Done' },
]
const meta: MessageMeta = {
  cg: [
    { beat: 2, status: 'pending', prompt: 'A garden', attachmentId: null },
    { beat: 3, status: 'error', prompt: 'A river', attachmentId: null },
  ],
}

test('CG 使用原始拍下标，pending 和 done 停，error、无任务和流式不停', () => {
  expect(shownBeatIndexes(beats, meta.cg)).toEqual([1, 2, 4])
  expect(shownBeatIndexes(beats)).toEqual([1, 4])
  expect(currentCg(beats, 2, meta)).toEqual({ status: 'pending', url: undefined, prompt: 'A garden' })
  expect(currentCg(beats, 3, meta)).toBeUndefined()
  expect(currentCg(beats, 2)).toBeUndefined()
  expect(currentCg(beats, 1, meta)).toBeUndefined()
  const done: MessageMeta = {
    cg: [{ ...meta.cg![0]!, status: 'done', attachmentId: 'image' }],
    images: [{ id: 'image', url: '/cg.png', width: 1, height: 1 }],
  }
  expect(shownBeatIndexes(beats, done.cg)).toEqual([1, 2, 4])
  expect(currentCg(beats, 2, done)?.url).toBe('/cg.png')
})

test('自动播放等待 pending，CG 完成后等待双倍，文字时长封顶', () => {
  expect(autoAdvanceDelay(2, 0, currentCg(beats, 2, meta))).toBeNull()
  expect(autoAdvanceDelay(2, 0, { status: 'done', prompt: '', url: '/cg' })).toBe(4000)
  expect(autoAdvanceDelay(2, 10)).toBe(2300)
  expect(autoAdvanceDelay(2, 1000)).toBe(5000)
})
