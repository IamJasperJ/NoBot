import { expect, spyOn, test } from 'bun:test'
import { type AudioTrackDTO, playPresetDataSchema } from '@nobot/shared'
import * as React from 'react'
import * as audioApi from '../../../api/audio'
import * as prefs from '../../../stores/audioPrefs'
import type { SlotProps } from '../../types'
import { audioEngine } from './engine'
import { useVnAudio } from './useVnAudio'

test('VN 音频：匹配、保持、停止、跨拍音效去重、跳读、换消息和卸载', () => {
  const tracks = [
    { name: 'Night Forest', kind: 'bgm', url: '/night' },
    { name: 'Bell', kind: 'sfx', url: '/bell' },
  ] as AudioTrackDTO[]
  const query = spyOn(audioApi, 'useAudioTracks').mockReturnValue({ data: tracks } as ReturnType<
    typeof audioApi.useAudioTracks
  >)
  const state = { ...prefs.useAudioPrefs.getState(), master: 50, muted: false }
  const pref = spyOn(prefs, 'useAudioPrefs').mockImplementation(((selector: (value: typeof state) => unknown) =>
    selector(state)) as typeof prefs.useAudioPrefs)
  // 模拟依赖比较和持久 ref，验证连续渲染行为；不替换引擎模块，避免影响其他测试。
  const effects: { deps?: React.DependencyList; cleanup?: () => void }[] = []
  const refs: { current: unknown }[] = []
  let effectIndex = 0
  let refIndex = 0
  const effect = spyOn(React, 'useEffect').mockImplementation((callback, deps) => {
    const index = effectIndex++
    const previous = effects[index]
    if (
      previous &&
      deps &&
      previous.deps?.length === deps.length &&
      deps.every((value, i) => Object.is(value, previous.deps?.[i]))
    )
      return
    previous?.cleanup?.()
    effects[index] = { deps, cleanup: callback() || undefined }
  })
  const ref = spyOn(React, 'useRef').mockImplementation(((value: unknown) => {
    const index = refIndex++
    refs[index] ??= { current: value }
    return refs[index]
  }) as typeof React.useRef)
  const bgm = spyOn(audioEngine, 'playBgm').mockImplementation(() => {})
  const sfx = spyOn(audioEngine, 'playSfx').mockImplementation(() => {})
  const volumes = spyOn(audioEngine, 'setVolumes').mockImplementation(() => {})
  const stop = spyOn(audioEngine, 'stopAll').mockImplementation(() => {})
  const props: SlotProps['vn.layer'] = {
    chatId: 'chat',
    stage: { scene: { bgm: 'forest' }, cast: [] },
    play: playPresetDataSchema.parse({}),
    playKey: 'a#0',
    beatIndex: 0,
    skipping: false,
    beats: [
      { kind: 'narration', text: 'start' },
      { kind: 'sfx', name: 'bell' },
      { kind: 'narration', text: 'end' },
      { kind: 'sfx', name: 'Bell' },
      { kind: 'narration', text: 'end' },
    ],
  }
  const render = () => {
    effectIndex = 0
    refIndex = 0
    useVnAudio(props)
  }
  try {
    render()
    expect(bgm).toHaveBeenLastCalledWith('/night', 1000)
    expect(volumes).toHaveBeenLastCalledWith({ master: 50, muted: false, bgm: 60, sfx: 80, voice: 100 })
    props.stage.scene.bgm = 'wrong'
    render()
    expect(bgm).toHaveBeenCalledTimes(1)
    props.stage.scene.bgm = ''
    render()
    expect(bgm).toHaveBeenLastCalledWith(null, 1000)
    props.stage.scene.bgm = undefined
    render()
    expect(bgm).toHaveBeenLastCalledWith(null, 1000)
    props.beatIndex = 2
    render()
    expect(sfx).toHaveBeenCalledTimes(1)
    render()
    props.beatIndex = 0
    render()
    props.beatIndex = 2
    render()
    expect(sfx).toHaveBeenCalledTimes(1)
    props.beatIndex = 4
    props.skipping = true
    render()
    expect(sfx).toHaveBeenCalledTimes(1)
    props.playKey = 'b#0'
    props.skipping = false
    render()
    expect(sfx).toHaveBeenCalledTimes(1)
    props.beatIndex = 0
    render()
    props.beatIndex = 2
    render()
    expect(sfx).toHaveBeenCalledTimes(2)
    props.playKey = 'b#1'
    props.beatIndex = 4
    render()
    expect(sfx).toHaveBeenCalledTimes(2)
    // 音频库还没加载完时不推进进度，加载好后再补播开头的音效
    query.mockReturnValue({ data: undefined } as ReturnType<typeof audioApi.useAudioTracks>)
    props.playKey = 'd#0'
    props.beats = [
      { kind: 'sfx', name: 'Bell' },
      { kind: 'narration', text: 'cold open' },
    ]
    props.beatIndex = 1
    render()
    expect(sfx).toHaveBeenCalledTimes(2)
    query.mockReturnValue({ data: tracks } as ReturnType<typeof audioApi.useAudioTracks>)
    render()
    expect(sfx).toHaveBeenCalledTimes(3)
    // 新消息从开头演：开头的 <sfx> 在第一句之前，换消息时补播
    props.playKey = 'c#0'
    props.beats = [
      { kind: 'sfx', name: 'Bell' },
      { kind: 'narration', text: 'door opens' },
    ]
    props.beatIndex = 1
    render()
    expect(sfx).toHaveBeenCalledTimes(4)
    state.muted = true
    props.play.audio.bgmVolume = 20
    render()
    expect(volumes).toHaveBeenLastCalledWith({ master: 50, muted: true, bgm: 20, sfx: 80, voice: 100 })
    for (const item of effects) item.cleanup?.()
    expect(stop).toHaveBeenCalledTimes(1)
  } finally {
    for (const mock of [query, pref, effect, ref, bgm, sfx, volumes, stop]) mock.mockRestore()
  }
})
