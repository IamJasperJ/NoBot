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
  const stop = spyOn(ttsPlayer, 'stop').mockImplementation(() => {})
  const props: SlotProps['vn.layer'] = {
    chatId: 'chat',
    playKey: 'm#1',
    beatIndex: 0,
    skipping: false,
    play: playPresetDataSchema.parse({}),
    stage: { scene: {}, cast: [{ key: 'alice', name: 'Alice', characterId: 'card', at: 'center', expression: '' }] },
    beats: [
      { kind: 'line', speaker: 'Alice', text: 'Hi', expression: 'joy' },
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
    expect(speak).toHaveBeenLastCalledWith('chat', { kind: 'character', characterId: 'card' }, 'Hi', 'joy')
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
    props.playKey = 'm#2'
    props.beatIndex = 0
    render()
    expect(speak).toHaveBeenCalledTimes(3)
    props.beatIndex = 2
    render()
    expect(speak).toHaveBeenLastCalledWith('chat', { kind: 'npc', name: 'Bob' }, 'Hello', undefined)
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
    }
  } finally {
    for (const entry of effects) entry.cleanup?.()
    for (const complete of completions) complete()
    query.mockRestore()
    effect.mockRestore()
    ref.mockRestore()
    speak.mockRestore()
    stop.mockRestore()
    useVnVoiceStore.setState({ busyKey: null })
  }
})
