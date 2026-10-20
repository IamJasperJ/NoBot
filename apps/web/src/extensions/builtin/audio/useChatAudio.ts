import { matchByName } from '@nobot/core/stage'
import type { AudioTrackDTO } from '@nobot/shared'
import { useEffect } from 'react'
import { type ChatBgm, useAudioTracks, useChatBgm } from '../../../api/audio'
import { useChatPages, useExtensions, usePlayPresets } from '../../../api/queries'
import { useAudioPrefs } from '../../../stores/audioPrefs'
import { audioEngine } from './engine'

/**
 * 播放哪首：用户手动指定（锁定）的优先，包括「不播放」；其次是舞台指令的 <bgm>（空字符串是显式停止）；
 * 最后是自动选曲的结果（只在自动选曲开启时生效）。
 */
export function chatBgmUrl(
  stageName: string | undefined,
  record: ChatBgm | null | undefined,
  tracks: AudioTrackDTO[],
  auto: boolean,
) {
  if (record?.source === 'manual' && record.locked) return record.track?.url ?? null
  if (stageName !== undefined)
    return stageName === ''
      ? null
      : (matchByName(
          stageName,
          tracks.filter((v) => v.kind === 'bgm'),
        )?.url ?? null)
  if (record && (record.source === 'manual' || auto)) return record.track?.url ?? null
  return null
}
export function useChatAudio(chatId: string) {
  const page = useChatPages(chatId).data?.pages[0]
  const play = usePlayPresets().data?.find((p) => p.id === page?.playPresetId)?.data
  const extension = useExtensions().data?.find((e) => e.id === 'audio')
  const { data: tracks } = useAudioTracks()
  const { data: record } = useChatBgm(chatId)
  const master = useAudioPrefs((s) => s.master)
  const muted = useAudioPrefs((s) => s.muted)
  const audio = play?.audio
  const enabled = !!page && !!play && extension?.enabled && extension.settings.chatBgm !== false
  const stageName = play?.directives.enabled ? page?.stage?.scene.bgm : undefined
  const url = chatBgmUrl(stageName, record, tracks ?? [], extension?.settings.autoBgm === true)
  // 会话切换时先释放旧曲目，随后新的播放 effect 接管，避免清理把新曲目停掉。
  useEffect(() => () => audioEngine.playBgm(null, 0), [chatId])
  useEffect(() => {
    audioEngine.playBgm(enabled ? url : null, audio?.fadeMs ?? 1000)
  }, [chatId, enabled, url, audio?.fadeMs])
  useEffect(() => {
    if (audio)
      audioEngine.setVolumes({ master, muted, bgm: audio.bgmVolume, sfx: audio.sfxVolume, voice: audio.voiceVolume })
  }, [master, muted, audio])
}
