import { expect, test } from 'bun:test'
import { AudioEngine } from './engine'

class FakeAudio {
  src = ''
  volume = 1
  loop = false
  plays = 0
  pauses = 0
  reject = false
  onended: (() => void) | null = null
  play() {
    this.plays++
    return this.reject ? Promise.reject(new Error('blocked')) : Promise.resolve()
  }
  pause() {
    this.pauses++
  }
  removeAttribute() {
    this.src = ''
  }
  load() {}
}
function setup() {
  let now = 0
  let serial = 0
  const frames = new Map<number, FrameRequestCallback>()
  const audios: FakeAudio[] = []
  const gestures = new EventTarget()
  const engine = new AudioEngine({
    createAudio: () => {
      const audio = new FakeAudio()
      audios.push(audio)
      return audio as unknown as HTMLAudioElement
    },
    now: () => now,
    frame: (callback) => {
      frames.set(++serial, callback)
      return serial
    },
    cancelFrame: (id) => {
      frames.delete(id)
    },
    gestures,
  })
  const tick = (time: number) => {
    now = time
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(time)
  }
  return { engine, audios, tick, gestures, frames }
}
test('BGM 循环、同曲不重启、交叉淡入和停止', () => {
  const { engine, audios, tick, frames } = setup()
  engine.setVolumes({ master: 100, bgm: 100, sfx: 100, muted: false })
  engine.playBgm('a', 1000)
  expect(audios[0]?.loop).toBe(true)
  expect(audios[0]?.volume).toBe(0)
  tick(500)
  expect(audios[0]?.volume).toBeCloseTo(0.5)
  tick(1000)
  engine.playBgm('a', 1000)
  expect(audios[0]?.plays).toBe(1)
  engine.playBgm('b', 1000)
  tick(1500)
  expect(audios.map((a) => a.volume)).toEqual([0.5, 0.5])
  tick(2000)
  expect(audios[0]?.src).toBe('')
  expect(audios[1]?.volume).toBe(1)
  engine.playBgm(null, 500)
  tick(2250)
  expect(audios[1]?.volume).toBeCloseTo(0.5)
  tick(2500)
  expect(audios[1]?.src).toBe('')
  expect(frames.size).toBe(0)
})
test('快速切曲从当前增益继续；卸载取消淡入和资源', () => {
  const { engine, audios, tick, frames } = setup()
  engine.playBgm('a', 0)
  engine.playBgm('b', 1000)
  tick(500)
  engine.playBgm('c', 1000)
  expect(audios[1]?.volume).toBeCloseTo(0.3)
  tick(1000)
  expect(audios[1]?.volume).toBeCloseTo(0.15)
  engine.stopAll()
  expect(audios.every((audio) => audio.src === '')).toBe(true)
  expect(frames.size).toBe(0)
})
test('音效最多四个，播完释放，音量换算和静音覆盖所有通道', () => {
  const { engine, audios } = setup()
  engine.setVolumes({ master: 50, bgm: 40, sfx: 20, muted: false })
  engine.playBgm('bgm', 0)
  expect(audios[0]?.volume).toBeCloseTo(0.2)
  for (let i = 0; i < 5; i++) engine.playSfx(String(i))
  expect(audios[2]?.src).toBe('')
  expect(audios[6]?.volume).toBeCloseTo(0.1)
  expect(audios[6]?.loop).toBe(false)
  engine.setVolumes({ master: 100, bgm: 100, sfx: 100, muted: true })
  expect(audios[0]?.volume).toBe(0)
  expect(audios[6]?.volume).toBe(0)
  audios[6]?.onended?.()
  expect(audios[6]?.src).toBe('')
  engine.stopAll()
})
test('自动播放拒绝后只在下一次手势重试一次；停止后的异步拒绝不复活', async () => {
  const { engine, audios, gestures } = setup()
  engine.playBgm('a', 0)
  engine.stopAll()
  audios[1]!.reject = true
  engine.playBgm('b', 0)
  // stopAll 后从第一个通道重新开始。
  audios[0]!.reject = true
  engine.playBgm('c', 0)
  await Promise.resolve()
  expect(audios[1]?.plays).toBe(1)
  gestures.dispatchEvent(new Event('pointerdown'))
  expect(audios[1]?.plays).toBe(2)
  await Promise.resolve()
  gestures.dispatchEvent(new Event('keydown'))
  expect(audios[1]?.plays).toBe(2)
  engine.playBgm('d', 0)
  engine.stopAll()
  await Promise.resolve()
  const count = audios[0]!.plays
  gestures.dispatchEvent(new Event('pointerdown'))
  expect(audios[0]?.plays).toBe(count)
})
