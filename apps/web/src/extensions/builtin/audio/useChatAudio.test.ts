import { expect, spyOn, test } from 'bun:test'
import { type AudioTrackDTO, playPresetDataSchema } from '@nobot/shared'
import * as React from 'react'
import * as audioApi from '../../../api/audio'
import * as queries from '../../../api/queries'
import * as prefs from '../../../stores/audioPrefs'
import { audioEngine } from './engine'
import { chatBgmUrl, useChatAudio } from './useChatAudio'

const tracks = [
  { id: 'night', name: 'Night Forest', kind: 'bgm', url: '/night' },
  { id: 'bell', name: 'Bell', kind: 'sfx', url: '/bell' },
] as AudioTrackDTO[]
const manual: audioApi.ChatBgm = { trackId: 'night', source: 'manual', locked: true, updatedAt: 1, track: tracks[0]! }
const picked: audioApi.ChatBgm = { ...manual, source: 'auto', locked: false }
test('聊天 BGM 优先级：手动锁定优先、舞台显式停止、名字匹配、自动设置与失效曲目', () => {
  // 手动指定的曲目和「不播放」都压过舞台指令
  expect(chatBgmUrl('', manual, tracks, true)).toBe('/night')
  expect(chatBgmUrl('forest', { ...manual, trackId: null, track: null }, tracks, true)).toBeNull()
  expect(chatBgmUrl('', picked, tracks, true)).toBeNull()
  expect(chatBgmUrl('forest', { ...picked, track: null }, tracks, false)).toBe('/night')
  expect(chatBgmUrl('Bell', picked, tracks, true)).toBeNull()
  expect(chatBgmUrl(undefined, manual, tracks, false)).toBe('/night')
  expect(chatBgmUrl(undefined, { ...manual, trackId: null, track: null }, tracks, true)).toBeNull()
  expect(chatBgmUrl(undefined, { ...manual, source: 'auto' }, tracks, false)).toBeNull()
  expect(chatBgmUrl(undefined, { ...manual, source: 'auto' }, tracks, true)).toBe('/night')
  expect(chatBgmUrl(undefined, null, tracks, true)).toBeNull()
})

test('聊天播放 hook：预设音量、舞台优先、禁用停止、切会话和卸载（VN 接管）', () => {
  const play = playPresetDataSchema.parse({ directives: { enabled: true }, audio: { bgmVolume: 42, fadeMs: 123 } })
  const page = { playPresetId: 'preset', stage: { scene: { bgm: undefined as string | undefined }, cast: [] } }
  const settings = { chatBgm: true, autoBgm: true }
  const state = { ...prefs.useAudioPrefs.getState(), master: 30, muted: false }
  const spies = [
    spyOn(audioApi, 'useAudioTracks').mockReturnValue({ data: tracks } as ReturnType<typeof audioApi.useAudioTracks>),
    spyOn(audioApi, 'useChatBgm').mockReturnValue({ data: picked } as ReturnType<typeof audioApi.useChatBgm>),
    spyOn(queries, 'useChatPages').mockReturnValue({ data: { pages: [page] } } as unknown as ReturnType<
      typeof queries.useChatPages
    >),
    spyOn(queries, 'usePlayPresets').mockReturnValue({ data: [{ id: 'preset', data: play }] } as ReturnType<
      typeof queries.usePlayPresets
    >),
    spyOn(queries, 'useExtensions').mockReturnValue({
      data: [{ id: 'audio', enabled: true, settings }],
    } as unknown as ReturnType<typeof queries.useExtensions>),
    spyOn(prefs, 'useAudioPrefs').mockImplementation(((selector: (value: typeof state) => unknown) =>
      selector(state)) as typeof prefs.useAudioPrefs),
  ]
  const effects: { deps?: React.DependencyList; cleanup?: () => void }[] = []
  let index = 0
  const effect = spyOn(React, 'useEffect').mockImplementation((callback, deps) => {
    const i = index++
    const previous = effects[i]
    if (
      previous &&
      deps &&
      previous.deps?.length === deps.length &&
      deps.every((v, n) => Object.is(v, previous.deps?.[n]))
    )
      return
    previous?.cleanup?.()
    effects[i] = { deps, cleanup: callback() || undefined }
  })
  const bgm = spyOn(audioEngine, 'playBgm').mockImplementation(() => {})
  const volumes = spyOn(audioEngine, 'setVolumes').mockImplementation(() => {})
  const render = (id = 'chat') => {
    index = 0
    useChatAudio(id)
  }
  try {
    render()
    expect(bgm).toHaveBeenLastCalledWith('/night', 123)
    expect(volumes).toHaveBeenLastCalledWith({ master: 30, muted: false, bgm: 42, sfx: 80, voice: 100 })
    page.stage.scene.bgm = ''
    render()
    expect(bgm).toHaveBeenLastCalledWith(null, 123)
    page.stage.scene.bgm = 'forest'
    render()
    expect(bgm).toHaveBeenLastCalledWith('/night', 123)
    settings.chatBgm = false
    render()
    expect(bgm).toHaveBeenLastCalledWith(null, 123)
    settings.chatBgm = true
    render('another')
    expect(bgm.mock.calls.slice(-2)).toEqual([
      [null, 0],
      ['/night', 123],
    ])
    for (const item of effects) item.cleanup?.()
    expect(bgm).toHaveBeenLastCalledWith(null, 0)
  } finally {
    for (const spy of spies) spy.mockRestore()
    effect.mockRestore()
    bgm.mockRestore()
    volumes.mockRestore()
  }
})
