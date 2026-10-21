import type { LineDelivery, SpokenLine, TtsLineResult, TtsSpeaker } from '@nobot/shared'
import { create } from 'zustand'
import { api as client } from '../../../api/client'
import { apiFetch } from '../../../api/fetch'
import { ttsApi } from '../../../api/tts'
import { t } from '../../../i18n'
import { useAudioPrefs } from '../../../stores/audioPrefs'
import { useVnVoiceStore } from '../../../stores/vnVoice'
import { audioEngine } from './engine'
import { getVisibleTtsChat } from './useStopTtsOnLeave'

export const useTtsPlayer = create<{ messageId: string | null; chatId: string | null; playing: boolean }>(() => ({
  messageId: null,
  chatId: null,
  playing: false,
}))
export const useTtsPlayback = useTtsPlayer
export class TtsPlayer {
  private controller?: AbortController
  private queue: { chatId: string; run: () => Promise<void> }[] = []
  private autoRead = new Set<string>()
  private queueEpoch = 0
  private draining = false
  private activeJob?: { chatId: string }

  /** 自动朗读与流式分段共用顺序；手动操作通过 stop 清空尚未开始的任务。 */
  enqueueMessage(chatId: string, messageId: string) {
    const key = `${chatId}:${messageId}`
    if (this.autoRead.has(key)) return
    this.autoRead.add(key)
    this.enqueue(chatId, () => this.speakMessage(messageId, chatId, true))
  }
  enqueueLine(
    chatId: string,
    segment: {
      speaker: TtsSpeaker
      text: string
      expression?: string
      delivery?: LineDelivery
      cues?: SpokenLine['cues']
    },
  ) {
    this.enqueue(chatId, () =>
      this.speakLine(
        chatId,
        segment.speaker,
        segment.text,
        segment.expression,
        segment.delivery,
        segment.cues,
        undefined,
        true,
      ),
    )
  }
  private enqueue(chatId: string, run: () => Promise<void>) {
    this.queue.push({ chatId, run })
    void this.drain()
  }
  private async drain() {
    if (this.draining || this.controller || !this.queue.length) return
    this.draining = true
    const epoch = this.queueEpoch
    let preparedChat: string | undefined
    try {
      while (epoch === this.queueEpoch && this.queue.length) {
        const job = this.queue.shift()!
        this.activeJob = job
        try {
          if (preparedChat !== job.chatId) {
            await this.prepareVolumes(job.chatId)
            preparedChat = job.chatId
          }
          if (epoch !== this.queueEpoch) return
          await job.run()
        } catch (error) {
          // 音量准备也可能失败；失败的回复不能堵住后续角色。
          if (epoch === this.queueEpoch)
            useVnVoiceStore.setState({
              lastVoiceError: { message: error instanceof Error ? error.message : t('语音播放失败'), at: Date.now() },
            })
        }
      }
    } finally {
      if (epoch === this.queueEpoch) {
        this.draining = false
        this.activeJob = undefined
        void this.drain()
      }
    }
  }
  private stoppedChats = new Set<string>()
  private cache = new Map<string, TtsLineResult>()
  private pending = new Map<string, Promise<TtsLineResult | undefined>>()
  private lineKey(
    chatId: string,
    speaker: TtsSpeaker,
    text: string,
    expression?: string,
    delivery?: LineDelivery,
    cues?: SpokenLine['cues'],
    context?: { messageId: string; beatIndex: number },
  ) {
    const identity = speaker.kind === 'character' ? speaker.characterId : speaker.kind === 'npc' ? speaker.name : ''
    return JSON.stringify([
      chatId,
      speaker.kind,
      identity,
      text,
      expression ?? null,
      delivery ?? null,
      cues ?? null,
      context ?? null,
    ])
  }
  private cached(key: string) {
    const result = this.cache.get(key)
    if (result) {
      this.cache.delete(key)
      this.cache.set(key, result)
    }
    return result
  }
  async prefetchLine(
    chatId: string,
    speaker: TtsSpeaker,
    text: string,
    expression?: string,
    delivery?: LineDelivery,
    cues?: SpokenLine['cues'],
    context?: { messageId: string; beatIndex: number },
  ) {
    const key = this.lineKey(chatId, speaker, text, expression, delivery, cues, context)
    if (this.cached(key)) return
    const existing = this.pending.get(key)
    if (existing) {
      await existing
      return
    }
    const task = (async () => {
      try {
        const result = await this.api.line({ chatId, speaker, text, expression, delivery, cues, ...context })
        if (result.kind === 'audio') {
          const response = await apiFetch(result.url)
          if (!response.ok) throw new Error('TTS prefetch failed')
          // 消费完整响应后浏览器才能缓存音频，避免播放时再等下载。
          await response.arrayBuffer()
        }
        if (!context) this.cache.set(key, result)
        if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!)
        return result
      } catch (error) {
        console.warn('TTS prefetch failed', error)
        return undefined
      }
    })()
    this.pending.set(key, task)
    try {
      await task
    } finally {
      this.pending.delete(key)
    }
  }
  constructor(
    private api = ttsApi,
    private engine = audioEngine,
    private prepareVolumes: (chatId: string) => Promise<void> = async () => {},
  ) {}
  stop() {
    this.queue = []
    this.queueEpoch++
    this.draining = false
    this.activeJob = undefined
    this.stopPlayback()
  }
  private stopPlayback() {
    this.controller?.abort()
    this.controller = undefined
    this.engine.stopVoice()
    useTtsPlayer.setState({ messageId: null, chatId: null, playing: false })
  }
  stopChat(chatId: string) {
    this.queue = this.queue.filter((job) => job.chatId !== chatId)
    const state = useTtsPlayer.getState()
    if (this.activeJob?.chatId === chatId) {
      // 在途音量准备也属于队列任务；离开后即使请求迟到也不能启动朗读。
      this.queueEpoch++
      this.draining = false
      this.activeJob = undefined
      if (state.chatId === chatId) this.stopPlayback()
      void this.drain()
    } else if (state.chatId === chatId) {
      this.stopPlayback()
      void this.drain()
    }
    // 未知归属的消息仍在请求时，记住离开的会话，收到结果后再按归属取消。
    else if (this.controller && state.chatId === null) this.stoppedChats.add(chatId)
  }
  private start(messageId: string | null, chatId: string | null, queued = false) {
    if (queued) this.stopPlayback()
    else this.stop()
    this.stoppedChats.clear()
    const controller = new AbortController()
    this.controller = controller
    useTtsPlayer.setState({ messageId, chatId, playing: true })
    return controller
  }
  private finish(controller: AbortController) {
    if (this.controller !== controller) return
    controller.abort()
    this.controller = undefined
    useTtsPlayer.setState({ messageId: null, chatId: null, playing: false })
    void this.drain()
  }
  private async play(result: TtsLineResult, signal: AbortSignal) {
    if (signal.aborted) return 'stopped'
    if (result.kind === 'skip') return 'skip'
    const outcome = await this.engine.playVoice(result.kind === 'audio' ? { url: result.url } : { browser: result })
    if (signal.aborted) return 'stopped'
    if (outcome === 'error') throw new Error(t('语音播放失败'))
    if (outcome === 'ended') useVnVoiceStore.setState({ lastVoiceError: null })
    return outcome
  }
  async speakLine(
    chatId: string,
    speaker: TtsSpeaker,
    text: string,
    expression?: string,
    delivery?: LineDelivery,
    cues?: SpokenLine['cues'],
    context?: { messageId: string; beatIndex: number },
    queued = false,
  ) {
    const controller = this.start(null, chatId, queued)
    try {
      const key = this.lineKey(chatId, speaker, text, expression, delivery, cues, context)
      const prepared = this.cached(key) ?? (await this.pending.get(key))
      if (controller.signal.aborted) return
      const result =
        prepared ??
        (await this.api.line({ chatId, speaker, text, expression, delivery, cues, ...context }, controller.signal))
      await this.play(result, controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) {
        useVnVoiceStore.setState({
          lastVoiceError: { message: error instanceof Error ? error.message : t('语音播放失败'), at: Date.now() },
        })
        throw error
      }
    } finally {
      this.finish(controller)
    }
  }
  async speakMessage(messageId: string, chatId: string | null = getVisibleTtsChat()?.chatId ?? null, queued = false) {
    const controller = this.start(messageId, chatId, queued)
    const signal = controller.signal
    try {
      const { chatId, segments } = await this.api.message(messageId, signal)
      if (signal.aborted) return
      if (this.stoppedChats.has(chatId)) {
        this.stop()
        return
      }
      useTtsPlayer.setState({ chatId })
      if (!queued) await this.prepareVolumes(chatId)
      if (signal.aborted) return
      // 预取也可能先失败；立即接住拒绝，等轮到该段时再抛出，避免未处理的 Promise。
      const prepare = (index: number) =>
        this.api.line({ chatId, ...segments[index]! }, signal).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        )
      let next = segments.length ? prepare(0) : undefined
      for (let index = 0; index < segments.length && !signal.aborted; index++) {
        const prepared = await next!
        if (signal.aborted) return
        if ('error' in prepared) throw prepared.error
        next = index + 1 < segments.length ? prepare(index + 1) : undefined
        const outcome = await this.play(prepared.result, signal)
        if (outcome === 'blocked' || outcome === 'stopped') break
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        useVnVoiceStore.setState({
          lastVoiceError: { message: error instanceof Error ? error.message : t('语音播放失败'), at: Date.now() },
        })
        throw error
      }
    } finally {
      this.finish(controller)
    }
  }
}
export const ttsPlayer = new TtsPlayer(ttsApi, audioEngine, async (chatId) => {
  const [page, presets] = await Promise.all([client.getChatPage(chatId), client.listPlayPresets()])
  const audio = presets.find((preset) => preset.id === page.playPresetId)?.data.audio
  const prefs = useAudioPrefs.getState()
  audioEngine.setVolumes({
    master: prefs.master,
    muted: prefs.muted,
    bgm: audio?.bgmVolume ?? 60,
    sfx: audio?.sfxVolume ?? 80,
    voice: audio?.voiceVolume ?? 100,
  })
})
