import type { DeliveryProsody } from '@nobot/shared'
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
export type VoiceOutcome = 'ended' | 'stopped' | 'error'
export interface AudioEngineOptions {
  speech?: SpeechSynthesis
  createUtterance?: (text: string) => SpeechSynthesisUtterance
  createAudio?: () => HTMLAudioElement
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
    this.speech = options.speech ?? (typeof speechSynthesis === 'undefined' ? undefined : speechSynthesis)
    this.createUtterance = options.createUtterance ?? ((text) => new SpeechSynthesisUtterance(text))
    this.createAudio = options.createAudio ?? (() => new Audio())
    this.now = options.now ?? (() => performance.now())
    this.frame = options.frame ?? ((cb) => requestAnimationFrame(cb))
    this.cancelFrame = options.cancelFrame ?? ((id) => cancelAnimationFrame(id))
    this.gestures = options.gestures ?? (typeof document === 'undefined' ? undefined : document)
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
    if (!this.pending.size) this.unlisten()
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
  private retry = () => {
    const pending = [...this.pending]
    this.pending.clear()
    this.unlisten()
    for (const [channel, token] of pending) if (channel.token === token) this.attempt(channel, true)
  }
  private listen() {
    if (this.listening) return
    this.listening = true
    this.gestures?.addEventListener('pointerdown', this.retry)
    this.gestures?.addEventListener('keydown', this.retry)
  }
  private unlisten() {
    this.listening = false
    this.gestures?.removeEventListener('pointerdown', this.retry)
    this.gestures?.removeEventListener('keydown', this.retry)
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
    return new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (outcome: VoiceOutcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.voiceAudio) {
          this.voiceAudio.onended = null
          this.voiceAudio.onerror = null
          this.voiceAudio.pause()
          this.voiceAudio.removeAttribute('src')
          this.voiceAudio.load()
        }
        if (this.utterance) {
          this.utterance.onend = null
          this.utterance.onerror = null
          this.speech?.cancel()
        }
        this.voiceAudio = undefined
        this.utterance = undefined
        this.finishVoice = undefined
        resolve(outcome)
      }
      this.finishVoice = finish
      // 媒体实现偶尔不发结束事件，兜底释放等待，避免 VN 永远停在当前拍。
      timer = setTimeout(() => finish('error'), 300000)
      try {
        if ('url' in source) {
          const audio = this.createAudio()
          this.voiceAudio = audio
          audio.src = source.url
          audio.volume = this.voiceVolume()
          audio.onended = () => finish('ended')
          audio.onerror = () => finish('error')
          void audio.play().catch(() => finish('error'))
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
          utterance.onend = () => finish('ended')
          utterance.onerror = () => finish('error')
          this.speech.speak(utterance)
        }
      } catch {
        finish('error')
      }
    })
  }
  stopVoice() {
    this.finishVoice?.('stopped')
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
