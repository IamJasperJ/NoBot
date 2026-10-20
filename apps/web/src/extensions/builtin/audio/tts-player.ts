import type { TtsLineResult, TtsSpeaker } from '@nobot/shared'
import { create } from 'zustand'
import { api as client } from '../../../api/client'
import { ttsApi } from '../../../api/tts'
import { t } from '../../../i18n'
import { useAudioPrefs } from '../../../stores/audioPrefs'
import { audioEngine } from './engine'

export const useTtsPlayer = create<{ messageId: string | null; playing: boolean }>(() => ({
  messageId: null,
  playing: false,
}))
export const useTtsPlayback = useTtsPlayer
export class TtsPlayer {
  private controller?: AbortController
  constructor(
    private api = ttsApi,
    private engine = audioEngine,
    private prepareVolumes: (chatId: string) => Promise<void> = async () => {},
  ) {}
  stop() {
    this.controller?.abort()
    this.controller = undefined
    this.engine.stopVoice()
    useTtsPlayer.setState({ messageId: null, playing: false })
  }
  private start(messageId: string | null) {
    this.stop()
    const controller = new AbortController()
    this.controller = controller
    useTtsPlayer.setState({ messageId, playing: true })
    return controller
  }
  private finish(controller: AbortController) {
    if (this.controller !== controller) return
    controller.abort()
    this.controller = undefined
    useTtsPlayer.setState({ messageId: null, playing: false })
  }
  private async play(result: TtsLineResult, signal: AbortSignal) {
    if (signal.aborted || result.kind === 'skip') return
    const outcome = await this.engine.playVoice(result.kind === 'audio' ? { url: result.url } : { browser: result })
    if (outcome === 'error') throw new Error(t('语音播放失败'))
  }
  async speakLine(chatId: string, speaker: TtsSpeaker, text: string, expression?: string) {
    const controller = this.start(null)
    try {
      await this.play(await this.api.line({ chatId, speaker, text, expression }, controller.signal), controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) throw error
    } finally {
      this.finish(controller)
    }
  }
  async speakMessage(messageId: string) {
    const controller = this.start(messageId)
    const signal = controller.signal
    try {
      const { chatId, segments } = await this.api.message(messageId, signal)
      if (signal.aborted) return
      await this.prepareVolumes(chatId)
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
        await this.play(prepared.result, signal)
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error
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
