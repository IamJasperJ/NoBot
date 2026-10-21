import type { DeliveryProsody } from '@nobot/shared'
import { t } from '../../../i18n'
import { useVnVoiceStore } from '../../../stores/vnVoice'

// 8kHz、8 位单声道的一个静音采样，解锁时不依赖网络。
const SILENCE = 'data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA'
const GESTURES = ['pointerdown', 'touchend', 'keydown'] as const
export interface AudioVolumes {
  master: number
  bgm: number
  sfx: number
  voice?: number
  muted: boolean
}
export type VoiceSource =
  | { url: string }
  | { browser: { voice: string; speed: number; text: string; adjustments?: DeliveryProsody } }
export type VoiceOutcome = 'ended' | 'stopped' | 'error' | 'blocked'
export interface AudioEngineOptions {
  speech?: SpeechSynthesis
  createUtterance?: (text: string) => SpeechSynthesisUtterance
  createAudio?: () => HTMLAudioElement
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  now?: () => number
  frame?: (callback: FrameRequestCallback) => number
  cancelFrame?: (id: number) => void
  gestures?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
}
interface Channel {
  audio: HTMLAudioElement
  gain: number
  token: number
}

/** 两个循环通道交替淡入；时钟和媒体构造可注入，测试无需真实设备。 */
export class AudioEngine {
  private voiceAudio?: HTMLAudioElement
  private voiceHadBlock = false
  private unlocked = false
  private unlocking = false
  private retryVoice?: () => void
  private setTimer: typeof setTimeout
  private clearTimer: typeof clearTimeout
  private utterance?: SpeechSynthesisUtterance
  private finishVoice?: (outcome: VoiceOutcome) => void
  private speech?: SpeechSynthesis
  private createUtterance: (text: string) => SpeechSynthesisUtterance
  private bgms: Channel[] = []
  private effects: Channel[] = []
  private current: Channel | undefined
  private url: string | null = null
  private voiceDeliveryVolume = 1
  private volumes: AudioVolumes = { master: 100, bgm: 60, sfx: 80, muted: false }
  private pending = new Map<Channel, number>()
  private frameId: number | undefined
  private listening = false
  private createAudio: () => HTMLAudioElement
  private now: () => number
  private frame: (callback: FrameRequestCallback) => number
  private cancelFrame: (id: number) => void
  private gestures: AudioEngineOptions['gestures']

  constructor(options: AudioEngineOptions = {}) {
    // 原生计时器不能脱离 window 调用（浏览器会报 Illegal invocation），包一层再存
    this.setTimer = options.setTimer ?? (((fn: () => void, ms?: number) => setTimeout(fn, ms)) as typeof setTimeout)
    this.clearTimer =
      options.clearTimer ?? (((id?: Parameters<typeof clearTimeout>[0]) => clearTimeout(id)) as typeof clearTimeout)
    this.speech = options.speech ?? (typeof speechSynthesis === 'undefined' ? undefined : speechSynthesis)
    this.createUtterance = options.createUtterance ?? ((text) => new SpeechSynthesisUtterance(text))
    this.createAudio = options.createAudio ?? (() => new Audio())
    this.now = options.now ?? (() => performance.now())
    this.frame = options.frame ?? ((cb) => requestAnimationFrame(cb))
    this.cancelFrame = options.cancelFrame ?? ((id) => cancelAnimationFrame(id))
    this.gestures =
      options.gestures ??
      (typeof document === 'undefined' || typeof document.addEventListener !== 'function' ? undefined : document)
    this.listen()
  }
  private channel(): Channel {
    return { audio: this.createAudio(), gain: 0, token: 0 }
  }
  private volume(channel: Channel, kind: 'bgm' | 'sfx') {
    channel.audio.volume = this.volumes.muted ? 0 : (channel.gain * this.volumes.master * this.volumes[kind]) / 10000
  }
  private release(channel: Channel) {
    channel.token++
    this.pending.delete(channel)
    channel.audio.pause()
    channel.audio.removeAttribute('src')
    channel.audio.load()
    channel.gain = 0
    this.updateListening()
  }
  private attempt(channel: Channel, retry = false) {
    const token = channel.token
    try {
      void channel.audio.play().catch(() => {
        // 切曲或卸载后才到达的拒绝不能复活已经停止的声音。
        if (channel.token !== token || retry) return
        this.pending.set(channel, token)
        this.listen()
      })
    } catch {
      if (!retry) {
        this.pending.set(channel, token)
        this.listen()
      }
    }
  }
  private markUnlocked() {
    this.unlocked = true
    useVnVoiceStore.setState({ unlocked: true })
    this.updateListening()
  }
  isUnlocked() {
    return this.unlocked
  }
  private retry = () => {
    // 所有 play/speak 都必须在手势调用栈内发出，不能先 await。
    if (this.retryVoice) this.retryVoice()
    else if (!this.unlocked && !this.unlocking && !this.finishVoice) {
      this.unlocking = true
      this.voiceAudio ??= this.createAudio()
      const audio = this.voiceAudio
      audio.src = SILENCE
      try {
        const playing = audio.play()
        void playing
          .then(
            () => {
              // play 尚未启动就 pause 会触发 AbortError；启动后暂停，且不能暂停已换上的新句。
              if (!this.finishVoice) audio.pause()
              this.markUnlocked()
            },
            () => {},
          )
          .finally(() => {
            this.unlocking = false
          })
      } catch {
        this.unlocking = false
      }
    }
    if (!this.utterance && this.speech && !this.unlocked) {
      try {
        const silent = this.createUtterance('')
        silent.volume = 0
        this.speech.speak(silent)
      } catch {
        // 系统语音不可用不应阻止其他通道解锁。
      }
    }
    const pending = [...this.pending]
    this.pending.clear()
    for (const [channel, token] of pending) if (channel.token === token) this.attempt(channel, true)
    this.updateListening()
  }
  private updateListening() {
    if (!this.unlocked || this.pending.size || this.retryVoice) this.listen()
    else this.unlisten()
  }
  private listen() {
    if (this.listening) return
    this.listening = true
    for (const event of GESTURES) this.gestures?.addEventListener(event, this.retry)
  }
  private unlisten() {
    if (!this.listening) return
    this.listening = false
    for (const event of GESTURES) this.gestures?.removeEventListener(event, this.retry)
  }
  playBgm(url: string | null, fadeMs: number) {
    if (this.url === url) return
    this.url = url
    if (this.frameId !== undefined) this.cancelFrame(this.frameId)
    this.frameId = undefined
    if (!this.bgms.length && url) this.bgms = [this.channel(), this.channel()]
    if (url) {
      const next = this.bgms.find((channel) => channel !== this.current)!
      this.release(next)
      next.audio.src = url
      next.audio.loop = true
      this.current = next
      this.volume(next, 'bgm')
      this.attempt(next)
    } else this.current = undefined
    const start = this.now()
    const gains = this.bgms.map((channel) => channel.gain)
    const duration = Number.isFinite(fadeMs) ? Math.max(0, fadeMs) : 0
    const tick = () => {
      const progress = duration === 0 ? 1 : Math.min(1, Math.max(0, (this.now() - start) / duration))
      this.bgms.forEach((channel, index) => {
        const target = channel === this.current ? 1 : 0
        channel.gain = gains[index]! + (target - gains[index]!) * progress
        this.volume(channel, 'bgm')
        if (progress === 1 && target === 0) this.release(channel)
      })
      this.frameId = progress < 1 ? this.frame(tick) : undefined
    }
    tick()
  }
  playSfx(url: string) {
    if (this.effects.length >= 4) this.release(this.effects.shift()!)
    const channel = this.channel()
    channel.gain = 1
    channel.audio.src = url
    channel.audio.loop = false
    channel.audio.onended = () => {
      this.effects = this.effects.filter((item) => item !== channel)
      this.release(channel)
    }
    this.effects.push(channel)
    this.volume(channel, 'sfx')
    this.attempt(channel)
  }
  private voiceVolume() {
    return this.volumes.muted ? 0 : (this.volumes.master * (this.volumes.voice ?? 100)) / 10000
  }
  playVoice(source: VoiceSource): Promise<VoiceOutcome> {
    this.stopVoice()
    this.voiceHadBlock = false
    this.updateListening()
    return new Promise((resolve) => {
      let settled = false
      let started = false
      let speechAttempted = false
      let blockedTimer: ReturnType<typeof setTimeout> | undefined
      let startTimer: ReturnType<typeof setTimeout> | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (outcome: VoiceOutcome) => {
        if (settled) return
        settled = true
        this.clearTimer(timer)
        this.clearTimer(startTimer)
        this.clearTimer(blockedTimer)
        if (this.voiceAudio) {
          this.voiceAudio.onended = null
          this.voiceAudio.onerror = null
          this.voiceAudio.pause()
          this.voiceAudio.removeAttribute('src')
          this.voiceAudio.load()
        }
        if (this.utterance) {
          this.utterance.onstart = null
          this.utterance.onend = null
          this.utterance.onerror = null
          this.speech?.cancel()
        }
        this.utterance = undefined
        this.finishVoice = undefined
        this.voiceHadBlock = false
        this.retryVoice = undefined
        useVnVoiceStore.setState({ voiceBlocked: false })
        if (outcome === 'error')
          useVnVoiceStore.setState({ lastVoiceError: { message: t('语音播放失败'), at: Date.now() } })
        if (outcome === 'ended') useVnVoiceStore.setState({ lastVoiceError: null })
        this.updateListening()
        resolve(outcome)
      }
      const playing = () => {
        if (settled) return
        started = true
        this.clearTimer(startTimer)
        this.clearTimer(blockedTimer)
        blockedTimer = undefined
        this.retryVoice = undefined
        useVnVoiceStore.setState({ voiceBlocked: false })
        this.markUnlocked()
      }
      const blocked = () => {
        if (settled) return
        this.voiceHadBlock = true
        useVnVoiceStore.setState({ voiceBlocked: true })
        this.retryVoice = attempt
        // 多次手势失败不能重新计时，否则可能无限阻塞自动模式。
        blockedTimer ??= this.setTimer(() => finish('blocked'), 60000)
        this.listen()
      }
      const failed = (error: unknown) => {
        if (settled) return
        if (error && typeof error === 'object' && 'name' in error && error.name === 'NotAllowedError') blocked()
        else finish('error')
      }
      const attempt = () => {
        if (settled) return
        try {
          if ('url' in source) void this.voiceAudio!.play().then(playing, failed)
          else {
            started = false
            this.clearTimer(startTimer)
            if (speechAttempted) {
              // cancel 的迟到事件不能结算重试中的新句，重试使用新的 utterance。
              const previous = this.utterance!
              const next = this.createUtterance(source.browser.text)
              next.voice = previous.voice
              next.rate = previous.rate
              next.pitch = previous.pitch
              next.volume = previous.volume
              next.onstart = previous.onstart
              next.onend = previous.onend
              next.onerror = previous.onerror
              previous.onstart = null
              previous.onend = null
              previous.onerror = null
              this.utterance = next
            }
            this.speech!.cancel()
            speechAttempted = true
            this.speech!.speak(this.utterance!)
            startTimer = this.setTimer(() => {
              if (!started && !this.speech!.speaking) blocked()
            }, 2000)
          }
        } catch (error) {
          failed(error)
        }
      }
      this.finishVoice = finish
      // 媒体实现偶尔不发结束事件，兜底释放等待，避免 VN 永远停在当前拍。
      timer = this.setTimer(() => finish('error'), 300000)
      try {
        if ('url' in source) {
          this.voiceAudio ??= this.createAudio()
          const audio = this.voiceAudio
          audio.src = source.url
          audio.volume = this.voiceVolume()
          audio.onended = () => finish('ended')
          audio.onerror = () => finish('error')
        } else {
          if (!this.speech) {
            finish('error')
            return
          }
          this.voiceDeliveryVolume = source.browser.adjustments?.volume ?? 1
          const utterance = this.createUtterance(source.browser.text)
          this.utterance = utterance
          const voice = this.speech.getVoices().find((v) => v.name === source.browser.voice)
          if (voice) utterance.voice = voice
          utterance.rate = Math.max(0.1, Math.min(10, source.browser.speed * (source.browser.adjustments?.rate ?? 1)))
          utterance.pitch = Math.max(0, Math.min(2, source.browser.adjustments?.pitch ?? 1))
          utterance.volume = Math.max(0, Math.min(1, this.voiceVolume() * (source.browser.adjustments?.volume ?? 1)))
          // 首次 speak 尚未回报 onstart 时，手势也可直接重试，不必等满两秒。
          this.retryVoice = attempt
          this.listen()
          utterance.onstart = playing
          utterance.onend = () => finish('ended')
          utterance.onerror = (event) => {
            if (event.error === 'not-allowed') blocked()
            else finish('error')
          }
        }
        attempt()
      } catch {
        finish('error')
      }
    })
  }
  stopVoice() {
    this.finishVoice?.('stopped')
  }
  wasVoiceBlocked() {
    return this.voiceHadBlock
  }
  isVoicePlaying() {
    return !!this.finishVoice
  }
  setVolumes(volumes: AudioVolumes) {
    const clamp = (value: number) => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0)
    this.volumes = {
      master: clamp(volumes.master),
      bgm: clamp(volumes.bgm),
      sfx: clamp(volumes.sfx),
      voice: clamp(volumes.voice ?? 100),
      muted: volumes.muted,
    }
    if (this.voiceAudio) this.voiceAudio.volume = this.voiceVolume()
    if (this.utterance) this.utterance.volume = Math.max(0, Math.min(1, this.voiceVolume() * this.voiceDeliveryVolume))
    for (const channel of this.bgms) this.volume(channel, 'bgm')
    for (const channel of this.effects) this.volume(channel, 'sfx')
  }
  stopAll() {
    this.stopVoice()
    if (this.frameId !== undefined) this.cancelFrame(this.frameId)
    this.frameId = undefined
    for (const channel of [...this.bgms, ...this.effects]) this.release(channel)
    this.effects = []
    this.current = undefined
    this.url = null
    this.pending.clear()
    this.unlisten()
  }
}
export const audioEngine = new AudioEngine()
