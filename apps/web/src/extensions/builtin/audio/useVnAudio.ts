import { matchByName } from '@nobot/core/stage'
import { useEffect, useRef } from 'react'
import { useAudioTracks } from '../../../api/audio'
import { useAudioPrefs } from '../../../stores/audioPrefs'
import type { SlotProps } from '../../types'
import { audioEngine } from './engine'

export function useVnAudio({ stage, beats, beatIndex, playKey, play, skipping }: SlotProps['vn.layer']) {
  const { data: tracks } = useAudioTracks()
  const master = useAudioPrefs((state) => state.master)
  const muted = useAudioPrefs((state) => state.muted)
  const { bgmVolume, sfxVolume, voiceVolume, fadeMs } = play.audio
  const name = stage.scene.bgm
  useEffect(() => {
    if (name === '' || name === undefined) audioEngine.playBgm(null, fadeMs)
    else {
      const track = matchByName(
        name,
        (tracks ?? []).filter((item) => item.kind === 'bgm'),
      )
      if (track) audioEngine.playBgm(track.url, fadeMs)
    }
  }, [name, tracks, fadeMs])
  useEffect(() => {
    audioEngine.setVolumes({ master, muted, bgm: bgmVolume, sfx: sfxVolume, voice: voiceVolume })
  }, [master, muted, bgmVolume, sfxVolume, voiceVolume])
  const position = useRef<{ key: string | null; index: number | undefined; played: Set<number> }>({
    key: null,
    index: undefined,
    played: new Set(),
  })
  useEffect(() => {
    // 音频库还没加载完时先不记进度：否则开头的音效会被当成「已处理」，等库加载好就补不回来了
    if (!tracks) return
    const previous = position.current
    const same = previous.key === playKey
    const played = same ? previous.played : new Set<number>()
    position.current = { key: playKey, index: beatIndex, played }
    if (!playKey || beatIndex === undefined) return
    let from: number
    if (same && previous.index !== undefined) {
      if (beatIndex <= previous.index) return
      from = previous.index + 1
    } else {
      // 刚打开 VN、换到新消息，或流式回复第一次有拍时：如果正从开头演（前面只有舞台和音效拍），
      // 补播开头的音效（比如回复第一行就是 <sfx>）；直接跳到中间时不补播
      const fromStart = beats.slice(0, beatIndex).every((beat) => beat.kind === 'stage' || beat.kind === 'sfx')
      if (!fromStart) return
      from = 0
    }
    for (let index = from; index <= beatIndex; index++) {
      const beat = beats[index]
      if (beat?.kind !== 'sfx' || played.has(index)) continue
      // 跳读经过的音效也标记已处理，回退后不能再次触发。
      played.add(index)
      if (skipping) continue
      const track = matchByName(
        beat.name,
        (tracks ?? []).filter((item) => item.kind === 'sfx'),
      )
      if (track) audioEngine.playSfx(track.url)
    }
  }, [beats, beatIndex, playKey, skipping, tracks])
  useEffect(() => () => audioEngine.stopAll(), [])
}
