import { expect, spyOn, test } from 'bun:test'
import { playPresetDataSchema } from '@nobot/shared'
import * as React from 'react'
import * as queries from '../../../api/tts'
import { useVnVoiceStore } from '../../../stores/vnVoice'
import type { SlotProps } from '../../types'
import { ttsPlayer } from './tts-player'
import { useVnVoice } from './useVnVoice'

test('VN 语音：说话人、等待、切句中断、回退去重、跳读与换备选', async () => {
  const query = spyOn(queries, 'useChatVoice').mockReturnValue({
    data: { effective: { enabled: true, vnVoice: true, vnWaitVoice: true, vnInterrupt: true } },
  } as unknown as ReturnType<typeof queries.useChatVoice>)
  const effects: { deps?: React.DependencyList; cleanup?: () => void }[] = []
  const refs: { current: unknown }[] = []
  let ei = 0
  let ri = 0
  const effect = spyOn(React, 'useEffect').mockImplementation((callback, deps) => {
    const index = ei++
    const old = effects[index]
    if (old && deps?.every((value, i) => Object.is(value, old.deps?.[i]))) return
    old?.cleanup?.()
    effects[index] = { deps, cleanup: callback() || undefined }
  })
  const ref = spyOn(React, 'useRef').mockImplementation(
    ((value: unknown) => (refs[ri++] ??= { current: value })) as typeof React.useRef,
  )
  const completions: (() => void)[] = []
  const speak = spyOn(ttsPlayer, 'speakLine').mockImplementation(
    () => new Promise<void>((resolve) => completions.push(resolve)),
  )
  const prefetch = spyOn(ttsPlayer, 'prefetchLine').mockResolvedValue(undefined)
  const stop = spyOn(ttsPlayer, 'stopChat').mockImplementation(() => {})
  const props: SlotProps['vn.layer'] = {
    chatId: 'chat',
    playKey: 'm#1',
    beatIndex: 0,
    skipping: false,
    play: playPresetDataSchema.parse({}),
    stage: { scene: {}, cast: [{ key: 'alice', name: 'Alice', characterId: 'card', at: 'center', expression: '' }] },
    beats: [
      {
        kind: 'line',
        speaker: 'Alice',
        text: 'Hi',
        expression: 'joy',
        delivery: { volume: 'whisper', intensity: 3, direction: 'holding back tears' },
        cues: [{ at: 0, cue: 'sigh' }],
      },
      { kind: 'narration', text: 'Night' },
      { kind: 'line', speaker: 'Bob', text: 'Hello' },
    ],
  }
  const render = () => {
    ei = 0
    ri = 0
    useVnVoice(props)
  }
  const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  }
  try {
    render()
    await flush()
    expect(prefetch.mock.calls.map((call) => call[2])).toEqual(['Hi', 'Night', 'Hello'])
    expect(prefetch).toHaveBeenLastCalledWith(
      'chat',
      { kind: 'npc', name: 'Bob' },
      'Hello',
      undefined,
      undefined,
      undefined,
      { messageId: 'm', beatIndex: 2 },
    )
    expect(speak).toHaveBeenLastCalledWith(
      'chat',
      { kind: 'character', characterId: 'card' },
      'Hi',
      'joy',
      { volume: 'whisper', intensity: 3, direction: 'holding back tears' },
      [{ at: 0, cue: 'sigh' }],
      { messageId: 'm', beatIndex: 0 },
    )
    expect(useVnVoiceStore.getState().busyKey).toBe('m#1:0')
    render()
    expect(speak).toHaveBeenCalledTimes(1)
    props.beatIndex = 1
    render()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(useVnVoiceStore.getState().busyKey).toBe('m#1:1')
    completions[0]!()
    await flush()
    expect(useVnVoiceStore.getState().busyKey).toBe('m#1:1')
    completions[1]!()
    await flush()
    expect(useVnVoiceStore.getState().busyKey).toBeNull()
    const prefetched = prefetch.mock.calls.length
    props.beatIndex = 0
    render()
    props.beatIndex = 1
    render()
    expect(speak).toHaveBeenCalledTimes(2)
    props.skipping = true
    props.beatIndex = 2
    render()
    props.skipping = false
    render()
    expect(speak).toHaveBeenCalledTimes(2)
    await flush()
    expect(prefetch).toHaveBeenCalledTimes(prefetched)
    props.playKey = 'm#2'
    props.beatIndex = 0
    render()
    expect(speak).toHaveBeenCalledTimes(3)
    props.beatIndex = 2
    render()
    expect(speak).toHaveBeenLastCalledWith(
      'chat',
      { kind: 'npc', name: 'Bob' },
      'Hello',
      undefined,
      undefined,
      undefined,
      { messageId: 'm', beatIndex: 2 },
    )
    await flush()
    const prefetchCount = prefetch.mock.calls.length
    const count = speak.mock.calls.length
    for (const effective of [
      { enabled: false, vnVoice: true },
      { enabled: true, vnVoice: false },
    ]) {
      query.mockReturnValue({ data: { effective } } as ReturnType<typeof queries.useChatVoice>)
      props.playKey += '-disabled'
      props.beatIndex = 0
      render()
      expect(speak).toHaveBeenCalledTimes(count)
      expect(prefetch).toHaveBeenCalledTimes(prefetchCount)
    }
  } finally {
    for (const entry of effects) entry.cleanup?.()
    for (const complete of completions) complete()
    query.mockRestore()
    effect.mockRestore()
    ref.mockRestore()
    speak.mockRestore()
    stop.mockRestore()
    prefetch.mockRestore()
    useVnVoiceStore.setState({ busyKey: null })
  }
})

test('VN 预取窗口最多三句、并发两句，流式追加完整拍可预取，旧消息不补取', async () => {
  const query = spyOn(queries, 'useChatVoice').mockReturnValue({
    data: { effective: { enabled: true, vnVoice: true } },
  } as ReturnType<typeof queries.useChatVoice>)
  const effects: { deps?: React.DependencyList; cleanup?: () => void }[] = []
  const refs: { current: unknown }[] = []
  let ei = 0
  let ri = 0
  const effect = spyOn(React, 'useEffect').mockImplementation((callback, deps) => {
    const index = ei++
    const old = effects[index]
    if (old && deps?.every((value, i) => Object.is(value, old.deps?.[i]))) return
    old?.cleanup?.()
    effects[index] = { deps, cleanup: callback() || undefined }
  })
  const ref = spyOn(React, 'useRef').mockImplementation(
    ((value: unknown) => (refs[ri++] ??= { current: value })) as typeof React.useRef,
  )
  const completions: (() => void)[] = []
  let running = 0
  let peak = 0
  const prefetch = spyOn(ttsPlayer, 'prefetchLine').mockImplementation(async () => {
    peak = Math.max(peak, ++running)
    await new Promise<void>((resolve) => completions.push(resolve))
    running--
  })
  const speak = spyOn(ttsPlayer, 'speakLine').mockResolvedValue(undefined)
  const stop = spyOn(ttsPlayer, 'stopChat').mockImplementation(() => {})
  const props: SlotProps['vn.layer'] = {
    chatId: 'chat',
    playKey: 'stream',
    beatIndex: 0,
    skipping: false,
    play: playPresetDataSchema.parse({}),
    stage: { scene: {}, cast: [] },
    beats: ['one', 'two', 'three', 'four', 'five'].map((text) => ({ kind: 'narration', text })),
  }
  const render = () => {
    ei = 0
    ri = 0
    useVnVoice(props)
  }
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  try {
    render()
    expect(prefetch.mock.calls.map((call) => call[2])).toEqual(['one', 'two'])
    props.beats = [...props.beats]
    render()
    completions[0]!()
    await flush()
    expect(prefetch.mock.calls.map((call) => call[2])).toEqual(['one', 'two', 'three'])
    completions[1]!()
    completions[2]!()
    await flush()
    expect(prefetch).toHaveBeenCalledTimes(3)
    props.beatIndex = 1
    render()
    expect(prefetch.mock.calls.slice(3).map((call) => call[2])).toEqual(['three', 'four'])
    completions[3]!()
    await flush()
    expect(prefetch.mock.calls.slice(3).map((call) => call[2])).toEqual(['three', 'four', 'five'])
    completions[4]!()
    completions[5]!()
    await flush()
    props.playKey = 'stream-next'
    props.beatIndex = 0
    props.beats = [{ kind: 'narration', text: 'start' }]
    render()
    completions[6]!()
    await flush()
    props.beats = [...props.beats, { kind: 'line', speaker: 'New NPC', text: 'arrived' }]
    render()
    expect(prefetch).toHaveBeenLastCalledWith(
      'chat',
      { kind: 'npc', name: 'New NPC' },
      'arrived',
      undefined,
      undefined,
      undefined,
      { messageId: 'stream-next', beatIndex: 1 },
    )
    completions[7]!()
    await flush()
    const count = prefetch.mock.calls.length
    props.playKey = 'old-message'
    props.beatIndex = 1
    render()
    expect(prefetch).toHaveBeenCalledTimes(count)
    expect(peak).toBe(2)
  } finally {
    for (const entry of effects) entry.cleanup?.()
    for (const complete of completions) complete()
    await flush()
    query.mockRestore()
    effect.mockRestore()
    ref.mockRestore()
    prefetch.mockRestore()
    speak.mockRestore()
    stop.mockRestore()
    useVnVoiceStore.setState({ busyKey: null })
  }
})

test('VN 不打断模式切句保留当前语音，换会话和卸载仍停止，离开的排队拍不再播放', async () => {
  const query = spyOn(queries, 'useChatVoice').mockReturnValue({
    data: { effective: { enabled: true, vnInterrupt: false } },
  } as ReturnType<typeof queries.useChatVoice>)
  const effects: { deps?: React.DependencyList; cleanup?: () => void }[] = []
  const refs: { current: unknown }[] = []
  let ei = 0
  let ri = 0
  const effect = spyOn(React, 'useEffect').mockImplementation((callback, deps) => {
    const index = ei++
    const old = effects[index]
    if (old && deps?.every((value, i) => Object.is(value, old.deps?.[i]))) return
    old?.cleanup?.()
    effects[index] = { deps, cleanup: callback() || undefined }
  })
  const ref = spyOn(React, 'useRef').mockImplementation(
    ((value: unknown) => (refs[ri++] ??= { current: value })) as typeof React.useRef,
  )
  let complete!: () => void
  const speak = spyOn(ttsPlayer, 'speakLine').mockImplementation(
    () =>
      new Promise<void>((r) => {
        complete = r
      }),
  )
  const prefetch = spyOn(ttsPlayer, 'prefetchLine').mockResolvedValue(undefined)
  const stop = spyOn(ttsPlayer, 'stopChat').mockImplementation(() => {})
  const props: SlotProps['vn.layer'] = {
    chatId: 'a',
    playKey: 'm',
    beatIndex: 0,
    skipping: false,
    play: playPresetDataSchema.parse({}),
    stage: { scene: {}, cast: [] },
    beats: [
      { kind: 'narration', text: 'first' },
      { kind: 'narration', text: 'queued' },
    ],
  }
  const render = () => {
    ei = 0
    ri = 0
    useVnVoice(props)
  }
  try {
    render()
    await Promise.resolve()
    expect(speak).toHaveBeenCalledTimes(1)
    props.beatIndex = 1
    render()
    expect(stop).not.toHaveBeenCalled()
    props.chatId = 'b'
    render()
    expect(stop).toHaveBeenLastCalledWith('a')
    for (const entry of effects) entry.cleanup?.()
    effects.length = 0
    expect(stop.mock.calls).toEqual([['a'], ['b']])
    complete()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(speak).toHaveBeenCalledTimes(1)
    expect(useVnVoiceStore.getState().busyKey).toBeNull()
  } finally {
    for (const entry of effects) entry.cleanup?.()
    complete?.()
    query.mockRestore()
    effect.mockRestore()
    ref.mockRestore()
    speak.mockRestore()
    prefetch.mockRestore()
    stop.mockRestore()
    useVnVoiceStore.setState({ busyKey: null })
  }
})
