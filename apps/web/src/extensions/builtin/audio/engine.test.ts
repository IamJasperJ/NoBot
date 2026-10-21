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

test('语音通道独立音量、结束、替换、停止及播放错误都结算 Promise', async () => {
  const { engine, audios } = setup()
  engine.setVolumes({ master: 50, bgm: 60, sfx: 80, voice: 40, muted: false })
  const first = engine.playVoice({ url: '/first' })
  expect(engine.isVoicePlaying()).toBe(true)
  expect(audios[0]!.volume).toBeCloseTo(0.2)
  const oldEnd = audios[0]!.onended
  const second = engine.playVoice({ url: '/second' })
  expect(await first).toBe('stopped')
  oldEnd?.()
  expect(engine.isVoicePlaying()).toBe(true)
  audios[0]!.onended?.()
  expect(await second).toBe('ended')
  expect(engine.isVoicePlaying()).toBe(false)
  const third = engine.playVoice({ url: '/third' })
  engine.stopAll()
  expect(await third).toBe('stopped')
  const broken = new AudioEngine({
    createAudio: () =>
      ({
        ...new FakeAudio(),
        play: () => Promise.reject(new Error('blocked')),
        pause() {},
        removeAttribute() {},
        load() {},
      }) as unknown as HTMLAudioElement,
  })
  expect(await broken.playVoice({ url: '/blocked' })).toBe('error')
})

test('浏览器语音按名字选声音、语速与音量，取消不依赖浏览器发事件', async () => {
  const utterances: SpeechSynthesisUtterance[] = []
  let cancelled = 0
  const voice = { name: 'Alice' } as SpeechSynthesisVoice
  const engine = new AudioEngine({
    speech: {
      getVoices: () => [voice],
      speak: (u: SpeechSynthesisUtterance) => utterances.push(u),
      cancel: () => {
        cancelled++
      },
    } as unknown as SpeechSynthesis,
    createUtterance: (text) => ({ text }) as SpeechSynthesisUtterance,
  })
  engine.setVolumes({ master: 50, bgm: 60, sfx: 80, voice: 60, muted: false })
  const result = engine.playVoice({ browser: { voice: 'Alice', speed: 1.2, text: 'hello' } })
  expect(utterances[0]).toMatchObject({ voice, rate: 1.2, volume: 0.3, text: 'hello' })
  engine.stopVoice()
  expect(await result).toBe('stopped')
  expect(cancelled).toBe(2)
})

test('浏览器应用演绎倍率、合法范围和播放中的音量更新', async () => {
  const utterances: SpeechSynthesisUtterance[] = []
  const engine = new AudioEngine({
    speech: {
      getVoices: () => [],
      speak: (u: SpeechSynthesisUtterance) => utterances.push(u),
      cancel: () => {},
    } as unknown as SpeechSynthesis,
    createUtterance: (text) => ({ text }) as SpeechSynthesisUtterance,
  })
  const result = engine.playVoice({
    browser: { voice: '', speed: 2, text: 'hello', adjustments: { rate: 0.9, pitch: 1.03, volume: 0.6 } },
  })
  expect(utterances[0]).toMatchObject({ rate: 1.8, pitch: 1.03, volume: 0.6 })
  engine.setVolumes({ master: 50, bgm: 100, sfx: 100, muted: false })
  expect(utterances[0]?.volume).toBe(0.3)
  engine.stopVoice()
  expect(await result).toBe('stopped')
  const clamped = engine.playVoice({
    browser: { voice: '', speed: 2, text: 'hello', adjustments: { rate: 100, pitch: 3, volume: 10 } },
  })
  expect(utterances[1]).toMatchObject({ rate: 10, pitch: 2, volume: 1 })
  engine.stopVoice()
  await clamped
})

// 用可推进时钟验证长等待，不让测试依赖真实一分钟。
function voiceSetup() {
  let clock = 0
  let serial = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const audio = new FakeAudio()
  const gestures = new EventTarget()
  const engine = new AudioEngine({
    gestures,
    createAudio: () => audio as unknown as HTMLAudioElement,
    setTimer: ((callback: () => void, delay: number) => {
      timers.set(++serial, { at: clock + delay, callback })
      return serial
    }) as unknown as typeof setTimeout,
    clearTimer: ((id: number) => timers.delete(id)) as unknown as typeof clearTimeout,
  })
  const tick = (ms: number) => {
    clock += ms
    for (const [id, timer] of timers) {
      if (timer.at > clock) continue
      timers.delete(id)
      timer.callback()
    }
  }
  return { engine, audio, gestures, tick, timers }
}
const flushVoice = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

test('解锁只注册一组手势，触摸也可解锁；语音复用解锁的常驻元素', async () => {
  const { spyOn } = await import('bun:test')
  const gestures = new EventTarget()
  const add = spyOn(gestures, 'addEventListener')
  const remove = spyOn(gestures, 'removeEventListener')
  const audio = new FakeAudio()
  let created = 0
  const silentUtterances: SpeechSynthesisUtterance[] = []
  const engine = new AudioEngine({
    gestures,
    speech: {
      speak: (utterance: SpeechSynthesisUtterance) => silentUtterances.push(utterance),
    } as unknown as SpeechSynthesis,
    createUtterance: (text) => ({ text }) as SpeechSynthesisUtterance,
    createAudio: () => {
      created++
      return audio as unknown as HTMLAudioElement
    },
  })
  expect(add).toHaveBeenCalledTimes(3)
  gestures.dispatchEvent(new Event('touchend'))
  expect(audio.src.startsWith('data:audio/wav;base64,')).toBe(true)
  expect(silentUtterances).toHaveLength(1)
  expect(silentUtterances[0]?.volume).toBe(0)
  await flushVoice()
  expect(audio.pauses).toBe(1)
  expect(engine.isUnlocked()).toBe(true)
  expect(remove).toHaveBeenCalledTimes(3)
  gestures.dispatchEvent(new Event('pointerdown'))
  expect(audio.plays).toBe(1)
  for (const url of ['/one', '/two']) {
    const task = engine.playVoice({ url })
    expect(audio.src).toBe(url)
    audio.onended?.()
    expect(await task).toBe('ended')
  }
  expect(created).toBe(1)
  expect(add).toHaveBeenCalledTimes(3)
  engine.stopAll()
})

test('播放被拦保持 Promise 和 busyKey，手势同步重试成功后清除 blocked', async () => {
  const { useVnVoiceStore } = await import('../../../stores/vnVoice')
  const { engine, audio, gestures, timers } = voiceSetup()
  audio.play = () => {
    audio.plays++
    return audio.reject ? Promise.reject(new DOMException('blocked', 'NotAllowedError')) : Promise.resolve()
  }
  audio.reject = true
  useVnVoiceStore.setState({ busyKey: 'm:0' })
  let resolved = false
  const task = engine.playVoice({ url: '/voice' }).then((outcome) => {
    resolved = true
    return outcome
  })
  await flushVoice()
  expect(useVnVoiceStore.getState().voiceBlocked).toBe(true)
  expect(useVnVoiceStore.getState().busyKey).toBe('m:0')
  expect(resolved).toBe(false)
  audio.reject = false
  gestures.dispatchEvent(new Event('keydown'))
  expect(audio.plays).toBe(2)
  await flushVoice()
  expect(useVnVoiceStore.getState().voiceBlocked).toBe(false)
  expect(resolved).toBe(false)
  audio.onended?.()
  expect(await task).toBe('ended')
  expect(timers.size).toBe(0)
  useVnVoiceStore.setState({ busyKey: null })
  engine.stopAll()
})

test('被拦最多等待 60 秒，多次失败手势不延长等待，停止后不补播', async () => {
  const { engine, audio, gestures, tick, timers } = voiceSetup()
  audio.play = () => {
    audio.plays++
    return Promise.reject(new DOMException('blocked', 'NotAllowedError'))
  }
  let resolved = false
  const task = engine.playVoice({ url: '/voice' }).then((outcome) => {
    resolved = true
    return outcome
  })
  await flushVoice()
  tick(59000)
  gestures.dispatchEvent(new Event('touchend'))
  await flushVoice()
  expect(resolved).toBe(false)
  tick(1000)
  expect(await task).toBe('blocked')
  expect(timers.size).toBe(0)
  const next = engine.playVoice({ url: '/old' })
  await flushVoice()
  engine.stopVoice()
  expect(await next).toBe('stopped')
  const plays = audio.plays
  // 成功解锁后才移除初始监听；这里停止全部资源，验证迟到手势不能重播。
  engine.stopAll()
  gestures.dispatchEvent(new Event('pointerdown'))
  expect(audio.plays).toBe(plays)
})

test('系统语音两秒无 onstart 且未 speaking 时阻塞，手势重试并等待真正结束', async () => {
  const { useVnVoiceStore } = await import('../../../stores/vnVoice')
  const gestures = new EventTarget()
  const timers = new Map<number, { callback: () => void; delay: number }>()
  let serial = 0
  const utterances: SpeechSynthesisUtterance[] = []
  const speech = {
    speaking: false,
    cancel() {},
    getVoices: () => [],
    speak: (utterance: SpeechSynthesisUtterance) => utterances.push(utterance),
  }
  const engine = new AudioEngine({
    gestures,
    speech: speech as unknown as SpeechSynthesis,
    createUtterance: (text) => ({ text }) as SpeechSynthesisUtterance,
    setTimer: ((callback: () => void, delay: number) => {
      timers.set(++serial, { callback, delay })
      return serial
    }) as unknown as typeof setTimeout,
    clearTimer: ((id: number) => timers.delete(id)) as unknown as typeof clearTimeout,
  })
  const task = engine.playVoice({ browser: { text: 'hello', voice: '', speed: 1 } })
  const check = [...timers.values()].find((timer) => timer.delay === 2000)!
  speech.speaking = true
  check.callback()
  expect(useVnVoiceStore.getState().voiceBlocked).toBe(false)
  speech.speaking = false
  check.callback()
  expect(useVnVoiceStore.getState().voiceBlocked).toBe(true)
  gestures.dispatchEvent(new Event('pointerdown'))
  expect(utterances).toHaveLength(2)
  utterances[1]!.onstart?.(new Event('start') as SpeechSynthesisEvent)
  expect(useVnVoiceStore.getState().voiceBlocked).toBe(false)
  expect(engine.isUnlocked()).toBe(true)
  utterances[1]!.onend?.(new Event('end') as SpeechSynthesisEvent)
  expect(await task).toBe('ended')
  expect(timers.size).toBe(0)
  engine.stopAll()
})

test('音频加载失败写入最近错误，成功结束一句才清掉', async () => {
  const { useVnVoiceStore } = await import('../../../stores/vnVoice')
  const { engine, audio } = voiceSetup()
  const failed = engine.playVoice({ url: '/bad' })
  ;(audio as unknown as HTMLAudioElement).onerror?.(new Event('error'))
  expect(await failed).toBe('error')
  expect(useVnVoiceStore.getState().lastVoiceError?.message).toBe('语音播放失败')
  expect(useVnVoiceStore.getState().lastVoiceError?.at).toBeGreaterThan(0)
  const success = engine.playVoice({ url: '/ok' })
  expect(useVnVoiceStore.getState().lastVoiceError).not.toBeNull()
  audio.onended?.()
  await success
  expect(useVnVoiceStore.getState().lastVoiceError).toBeNull()
  engine.stopAll()
})

test('默认计时器按浏览器接收者规则调用，媒体和系统语音方法保留所属对象', async () => {
  const { spyOn } = await import('bun:test')
  const nativeSet = globalThis.setTimeout
  const nativeClear = globalThis.clearTimeout
  let scheduled = 0
  let cleared = 0
  // Bun 的计时器允许任意 this；这里补上浏览器约束，避免注入 setTimer 掩盖默认路径回归。
  const checkReceiver = (receiver: unknown) => {
    if (receiver !== undefined && receiver !== globalThis) throw new TypeError('Illegal invocation')
  }
  const set = spyOn(globalThis, 'setTimeout').mockImplementation(function (
    this: unknown,
    callback: () => void,
    delay?: number,
  ) {
    checkReceiver(this)
    scheduled++
    return nativeSet(callback, delay)
  } as typeof setTimeout)
  const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(function (this: unknown, id) {
    checkReceiver(this)
    cleared++
    return nativeClear(id as number | undefined)
  } as typeof clearTimeout)
  const audio = new FakeAudio()
  const utterances: SpeechSynthesisUtterance[] = []
  const speech = {
    getVoices() {
      expect(this).toBe(speech)
      return []
    },
    cancel() {
      expect(this).toBe(speech)
    },
    speak(utterance: SpeechSynthesisUtterance) {
      expect(this).toBe(speech)
      utterances.push(utterance)
    },
  }
  const engine = new AudioEngine({
    createAudio: () => audio as unknown as HTMLAudioElement,
    speech: speech as unknown as SpeechSynthesis,
    createUtterance: (text) => ({ text }) as SpeechSynthesisUtterance,
  })
  try {
    const file = engine.playVoice({ url: '/default-timers.wav' })
    await flushVoice()
    expect(audio.plays).toBe(1)
    expect(engine.isVoicePlaying()).toBe(true)
    audio.onended?.()
    expect(await file).toBe('ended')
    const browser = engine.playVoice({ browser: { text: 'hello', voice: '', speed: 1 } })
    utterances[0]!.onstart?.(new Event('start') as SpeechSynthesisEvent)
    utterances[0]!.onend?.(new Event('end') as SpeechSynthesisEvent)
    expect(await browser).toBe('ended')
    expect(scheduled).toBe(3)
    expect(cleared).toBeGreaterThanOrEqual(6)
  } finally {
    engine.stopAll()
    set.mockRestore()
    clear.mockRestore()
  }
})
