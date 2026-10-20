import { castKey } from '@nobot/core/stage'
import type { TtsSpeaker } from '@nobot/shared'
import { useEffect, useRef } from 'react'
import { useChatVoice } from '../../../api/tts'
import { useVnVoiceStore } from '../../../stores/vnVoice'
import type { SlotProps } from '../../types'
import { ttsPlayer } from './tts-player'

export function useVnVoice({ chatId, stage, beats, beatIndex, playKey, skipping }: SlotProps['vn.layer']) {
  const settings = useChatVoice(chatId).data?.effective
  const enabled = settings?.enabled === true && settings?.vnVoice !== false
  const interrupt = settings?.vnInterrupt !== false
  const wait = settings?.vnWaitVoice !== false
  const ongoing = useRef<Promise<void>>(Promise.resolve())
  const seen = useRef(new Map<string, number>())
  useEffect(() => {
    if (!settings || !playKey || beatIndex === undefined) return
    const key = `${playKey}:${beatIndex}`
    const beat = beats[beatIndex]
    const previous = seen.current.get(playKey)
    seen.current.set(playKey, Math.max(previous ?? -1, beatIndex))
    // 只读向前进入的新拍；打开旧消息停在末尾、回退和跳过的拍都不能补读。
    const forward =
      previous === undefined
        ? beats.slice(0, beatIndex).every((b) => b.kind === 'stage' || b.kind === 'sfx')
        : beatIndex > previous
    if (!enabled || skipping || !forward || (beat?.kind !== 'line' && beat?.kind !== 'narration')) return
    let speaker: TtsSpeaker = { kind: 'narrator' }
    if (beat.kind === 'line') {
      const actor = stage.cast.find((a) => a.key === castKey(beat.speaker))
      speaker = actor?.characterId
        ? { kind: 'character', characterId: actor.characterId }
        : { kind: 'npc', name: actor?.name ?? beat.speaker }
    }
    if (wait) useVnVoiceStore.setState({ busyKey: key })
    let active = true
    const clear = () => {
      if (active && useVnVoiceStore.getState().busyKey === key) useVnVoiceStore.setState({ busyKey: null })
    }
    const speak = () =>
      active
        ? ttsPlayer.speakLine(chatId, speaker, beat.text, beat.kind === 'line' ? beat.expression : undefined)
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
      if (interrupt) ttsPlayer.stop()
    }
    // 同一拍的舞台或流式文本更新不能重新触发朗读。
  }, [chatId, playKey, beatIndex, enabled, skipping, interrupt, wait])
}
