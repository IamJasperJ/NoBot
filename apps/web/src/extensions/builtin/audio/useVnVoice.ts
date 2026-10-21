import { castKey } from '@nobot/core/stage'
import type { TtsSpeaker } from '@nobot/shared'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useChatVoice } from '../../../api/tts'
import { useVnVoiceStore } from '../../../stores/vnVoice'
import type { SlotProps } from '../../types'
import { audioEngine } from './engine'
import { ttsPlayer } from './tts-player'

type VnProps = SlotProps['vn.layer']
type SpokenBeat = Extract<VnProps['beats'][number], { kind: 'line' | 'narration' }>

function speakerOf(beat: SpokenBeat, stage: VnProps['stage']): TtsSpeaker {
  if (beat.kind === 'narration') return { kind: 'narrator' }
  const actor = stage.cast.find((a) => a.key === castKey(beat.speaker))
  return actor?.characterId
    ? { kind: 'character', characterId: actor.characterId }
    : { kind: 'npc', name: actor?.name ?? beat.speaker }
}

export function useVnVoice({
  chatId,
  stage,
  beats,
  beatIndex,
  playKey,
  skipping,
  streaming = false,
  replayToken = 0,
}: SlotProps['vn.layer']) {
  const settings = useChatVoice(chatId).data?.effective
  const enabled = settings?.enabled === true && settings?.vnVoice !== false
  const canRead = !streaming || settings?.streamRead === true
  const replayed = useRef(replayToken)
  const deferredBeat = useRef<string | null>(null)
  const interrupt = settings?.vnInterrupt !== false
  const wait = settings?.vnWaitVoice !== false
  const ongoing = useRef<Promise<void>>(Promise.resolve())
  const seen = useRef(new Map<string, number>())
  const prefetchSeen = useRef(new Map<string, { index: number; count: number }>())
  if (replayed.current !== replayToken) {
    seen.current.clear()
    prefetchSeen.current.clear()
    replayed.current = replayToken
  }
  const prefetchQueue = useRef<{ running: number; jobs: (() => Promise<void>)[] }>({ running: 0, jobs: [] })
  useEffect(() => () => ttsPlayer.stopChat(chatId), [chatId])
  useEffect(
    () => () => {
      // 同拍的流式刷新保留队列；离开当前拍、关闭或卸载时丢弃尚未开始的预取。
      prefetchQueue.current.jobs = []
    },
    [chatId, playKey, beatIndex, enabled, skipping],
  )
  useEffect(() => {
    if (!settings || !playKey || beatIndex === undefined || !canRead) return
    const previous = prefetchSeen.current.get(playKey)
    prefetchSeen.current.set(playKey, { index: Math.max(previous?.index ?? -1, beatIndex), count: beats.length })
    const forward =
      previous === undefined
        ? replayToken > 0 || beats.slice(0, beatIndex).every((b) => b.kind === 'stage' || b.kind === 'sfx')
        : beatIndex > previous.index || (beatIndex === previous.index && beats.length > previous.count)
    if (!enabled || skipping || !forward) return
    const queue = prefetchQueue.current
    // 首次进入时包含当前拍；流式追加完整拍时也补齐预取窗口。
    const upcoming = beats
      .slice(previous === undefined ? beatIndex : beatIndex + 1)
      .filter((beat): beat is SpokenBeat => beat.kind === 'line' || beat.kind === 'narration')
      .slice(0, 3)
    queue.jobs = upcoming.map((beat) => async () => {
      await ttsPlayer.prefetchLine(
        chatId,
        speakerOf(beat, stage),
        beat.text,
        beat.kind === 'line' ? beat.expression : undefined,
        beat.kind === 'line' ? beat.delivery : undefined,
        beat.kind === 'line' ? beat.cues : undefined,
        {
          messageId: playKey.includes('#') ? playKey.slice(0, playKey.lastIndexOf('#')) : playKey,
          beatIndex: beats.indexOf(beat),
        },
      )
    })
    const work = async () => {
      queue.running++
      try {
        while (queue.jobs.length) await queue.jobs.shift()!()
      } finally {
        queue.running--
      }
    }
    const available = Math.min(2 - queue.running, queue.jobs.length)
    for (let i = 0; i < available; i++) void work()
  }, [chatId, playKey, beatIndex, enabled, skipping, beats, canRead, replayToken])
  useLayoutEffect(() => {
    if (!settings || !playKey || beatIndex === undefined) return
    if (!canRead) {
      deferredBeat.current = `${playKey}:${beatIndex}`
      return
    }
    const key = `${playKey}:${beatIndex}`
    const beat = beats[beatIndex]
    const previous = seen.current.get(playKey)
    seen.current.set(playKey, Math.max(previous ?? -1, beatIndex))
    // 只读向前进入的新拍；打开旧消息停在末尾、回退和跳过的拍都不能补读。
    const forward =
      previous === undefined
        ? replayToken > 0 || beats.slice(0, beatIndex).every((b) => b.kind === 'stage' || b.kind === 'sfx')
        : beatIndex > previous
    const deferred = deferredBeat.current === key
    deferredBeat.current = null
    if (!enabled || skipping || (!forward && !deferred) || (beat?.kind !== 'line' && beat?.kind !== 'narration')) return
    const speaker = speakerOf(beat, stage)
    if (wait) useVnVoiceStore.setState({ busyKey: key })
    let active = true
    const clear = () => {
      if (active && useVnVoiceStore.getState().busyKey === key) useVnVoiceStore.setState({ busyKey: null })
    }
    const speak = () =>
      active
        ? ttsPlayer.speakLine(
            chatId,
            speaker,
            beat.text,
            beat.kind === 'line' ? beat.expression : undefined,
            beat.kind === 'line' ? beat.delivery : undefined,
            beat.kind === 'line' ? beat.cues : undefined,
            { messageId: playKey.includes('#') ? playKey.slice(0, playKey.lastIndexOf('#')) : playKey, beatIndex },
          )
        : Promise.resolve()
    // 不打断时等上一句完成；已离开的排队拍不再补播。
    const task = interrupt ? speak() : ongoing.current.then(speak, speak)
    ongoing.current = task
      .catch(() => {
        console.warn('TTS playback failed')
      })
      .finally(clear)
    return () => {
      clear()
      active = false
      // 手势可能已经重试旧句；离拍时仍要丢弃这句，不能排到新拍前面。
      if (interrupt || audioEngine.wasVoiceBlocked()) ttsPlayer.stopChat(chatId)
    }
    // 同一拍的舞台或流式文本更新不能重新触发朗读。
  }, [chatId, playKey, beatIndex, enabled, skipping, interrupt, wait, canRead, replayToken])
}
