import { expect, spyOn, test } from 'bun:test'
import { type MessageDTO, playPresetDataSchema } from '@nobot/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { message as baseMessage, setupHooks } from '../../api/hooks.test-utils'
import { useStreaming } from '../../stores/streaming'
import { useVn } from '../../stores/vn'
import { useVnVoiceStore } from '../../stores/vnVoice'
import { useVnPlayer } from './useVnPlayer'

test('临时 NPC 重新上台使用最新立绘映射，删除清空并兼容旧响应', () => {
  const { qc, render } = setupHooks()
  const message: MessageDTO = {
    ...baseMessage,
    content: '<show who="商队车夫" at="left" />\n车队启程了。',
    meta: {
      stage: {
        v: 1,
        ops: [{ op: 'show', who: '商队车夫', at: 'left' }],
        beats: [
          { kind: 'stage', ops: [{ op: 'show', who: '商队车夫', at: 'left' }] },
          { kind: 'narration', text: '车队启程了。' },
        ],
      },
    },
  }
  const options = {
    chatId: 'chat',
    messages: [message],
    play: playPresetDataSchema.parse({}),
    knownNames: ['商队车夫'],
    members: [],
  }
  const key = ['vn-stage', 'chat', message.id]
  const actor = { key: '商队车夫', name: '商队车夫', expression: '', at: 'left', spriteUrl: '/old.png' }
  try {
    qc.setQueryData(key, { stage: { scene: {}, cast: [] }, vars: {}, temporarySprites: { 商队车夫: '/driver.png' } })
    expect(render(() => useVnPlayer(options)).stage.cast).toEqual([
      expect.objectContaining({ key: '商队车夫', at: 'left', characterId: null, spriteUrl: '/driver.png' }),
    ])
    qc.setQueryData(key, {
      stage: { scene: {}, cast: [actor] },
      vars: {},
      temporarySprites: { 商队车夫: '/replacement.png' },
    })
    expect(render(() => useVnPlayer(options)).stage.cast[0]?.spriteUrl).toBe('/replacement.png')
    qc.setQueryData(key, { stage: { scene: {}, cast: [actor] }, vars: {}, temporarySprites: {} })
    expect(render(() => useVnPlayer(options)).stage.cast[0]?.spriteUrl).toBeUndefined()
    qc.setQueryData(key, { stage: { scene: {}, cast: [actor] }, vars: {} })
    expect(render(() => useVnPlayer(options)).stage.cast[0]?.spriteUrl).toBe('/old.png')
  } finally {
    qc.clear()
  }
})

test('CG 拍保留前句与名牌、已读快进 60ms、pending 自动等待、流式不暂停 CG', () => {
  const originalState = React.useState
  const effects: React.EffectCallback[] = []
  // 指定播放器初始游标，SSR 仍使用真实 React 状态；effect 手动提交以检查推进定时器。
  const state = spyOn(React, 'useState').mockImplementation(((initial: unknown) => {
    if (initial && typeof initial === 'object' && 'shown' in initial)
      return originalState({ id: 'message#1', shown: 1, revealed: Number.POSITIVE_INFINITY })
    return originalState(initial === false ? true : initial)
  }) as typeof React.useState)
  const effect = spyOn(React, 'useEffect').mockImplementation((callback) => {
    effects.push(callback)
  })
  const timeout = spyOn(globalThis, 'setTimeout')
  const previousRead = [...useVn.getInitialState().read]
  const previousStreaming = { ...useStreaming.getInitialState() }
  const qc = new QueryClient()
  let player!: ReturnType<typeof useVnPlayer>
  const message: MessageDTO = {
    id: 'message',
    chatId: 'chat',
    parentId: null,
    role: 'assistant',
    content: '<Alice>Hi</Alice><cg>A garden</cg>',
    status: 'done',
    speakerId: 'alice',
    createdAt: 1,
    swipeIndex: 1,
    swipeCount: 1,
    meta: {
      stage: {
        v: 1,
        ops: [],
        beats: [
          { kind: 'line', speaker: 'Alice', text: 'Hi' },
          { kind: 'cg', prompt: 'A garden' },
        ],
      },
      cg: [{ beat: 1, status: 'done', prompt: 'A garden', attachmentId: null }],
    },
  }
  const play = playPresetDataSchema.parse({})
  function Probe() {
    player = useVnPlayer({
      chatId: 'chat',
      messages: [
        { ...message, id: 'narration', role: 'system', content: 'Narration' },
        message,
        { ...message, id: 'roll', role: 'system', content: '2d1+3 = 5' },
      ],
      play,
      knownNames: ['Alice'],
      members: [{ id: 'alice', name: 'Alice' }],
    })
    return null
  }
  function render() {
    effects.length = 0
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    )
  }
  let cleanup: ReturnType<React.EffectCallback>
  try {
    // CG 后仍有拍，才能观察快进和自动播放的定时器。
    message.meta.stage!.beats.push({ kind: 'narration', text: 'After' })
    useVn.getInitialState().read.push('message#1:1')
    render()
    expect(player.cg?.status).toBe('done')
    expect(player.beatKey).toBe('message#1:1')
    expect(player.said).toMatchObject({ kind: 'line', speaker: 'Alice', text: 'Hi' })
    expect(player.revealedText).toBe('Hi')
    cleanup = effects.at(-1)!()
    expect(timeout.mock.calls.at(-1)?.[1]).toBe(60)
    if (cleanup) cleanup()
    cleanup = effects.at(-2)!()
    expect(timeout.mock.calls.at(-1)?.[1]).toBe(play.dialog.autoDelay * 2000)
    if (cleanup) cleanup()
    // 当前拍语音未结束时不建自动推进定时器；快进仍保留原来的 60ms。
    useVnVoiceStore.getInitialState().busyKey = 'message#1:1'
    render()
    const waitingCount = timeout.mock.calls.length
    effects.at(-2)!()
    expect(timeout.mock.calls.length).toBe(waitingCount)
    cleanup = effects.at(-1)!()
    expect(timeout.mock.calls.at(-1)?.[1]).toBe(60)
    if (cleanup) cleanup()
    useVnVoiceStore.getInitialState().busyKey = null
    render()
    cleanup = effects.at(-2)!()
    expect(timeout.mock.calls.at(-1)?.[1]).toBe(play.dialog.autoDelay * 2000)
    if (cleanup) cleanup()
    message.meta.cg![0]!.status = 'pending'
    render()
    const count = timeout.mock.calls.length
    effects.at(-2)!()
    expect(timeout.mock.calls.length).toBe(count)
    Object.assign(useStreaming.getInitialState(), {
      chatId: 'chat',
      messageId: message.id,
      text: `${message.content}\nAfter\n`,
    })
    render()
    expect(player.cg).toBeUndefined()
    expect(player.beat?.kind).not.toBe('cg')
  } finally {
    useVnVoiceStore.getInitialState().busyKey = null
    state.mockRestore()
    effect.mockRestore()
    timeout.mockRestore()
    useVn.getInitialState().read.splice(0, Number.POSITIVE_INFINITY, ...previousRead)
    Object.assign(useStreaming.getInitialState(), previousStreaming)
    qc.clear()
  }
})

test('群聊带选项队列手动与自动跨消息推进，末条选项等待，刷新不重演，回看保持独立语义', () => {
  const values: unknown[] = []
  const refs: { current: unknown }[] = []
  const effects: React.EffectCallback[] = []
  const timers: (() => void)[] = []
  let si = 0
  let ri = 0
  const state = spyOn(React, 'useState').mockImplementation(((initial: unknown) => {
    const index = si++
    if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial
    return [
      values[index],
      (next: unknown) => {
        values[index] = typeof next === 'function' ? next(values[index]) : next
      },
    ]
  }) as typeof React.useState)
  const ref = spyOn(React, 'useRef').mockImplementation(
    ((initial: unknown) => (refs[ri++] ??= { current: initial })) as typeof React.useRef,
  )
  const effect = spyOn(React, 'useEffect').mockImplementation((callback) => {
    effects.push(callback)
  })
  const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
    timers.push(callback)
    return 1
  }) as typeof setTimeout)
  const previousStreaming = { ...useStreaming.getInitialState() }
  const previousRead = [...useVn.getInitialState().read]
  const { qc, render } = setupHooks()
  const play = playPresetDataSchema.parse({ dialog: { cps: 0 } })
  const first: MessageDTO = {
    ...baseMessage,
    id: 'one',
    createdAt: Date.now() + 1000,
    meta: {
      stage: {
        v: 1,
        ops: [],
        beats: [
          { kind: 'narration', text: 'One' },
          { kind: 'choices', options: [{ text: 'First choice' }] },
        ],
      },
    },
  }
  const second: MessageDTO = {
    ...baseMessage,
    id: 'two',
    createdAt: Date.now() + 1001,
    status: 'streaming',
    meta: {
      stage: {
        v: 1,
        ops: [],
        beats: [
          { kind: 'narration', text: 'Three' },
          { kind: 'choices', options: [{ text: 'Last choice' }] },
        ],
      },
    },
  }
  const options = {
    chatId: 'chat',
    messages: [{ ...baseMessage, role: 'user' as const }, first],
    play,
    knownNames: [],
    members: [],
  }
  const draw = () => {
    si = 0
    ri = 0
    effects.length = 0
    timers.length = 0
    const player = render(() => useVnPlayer(options))
    for (const callback of effects) callback()
    return player
  }
  try {
    draw()
    draw()
    let player = draw()
    expect(player.current?.id).toBe('one')
    options.messages.push(second)
    Object.assign(useStreaming.getInitialState(), { chatId: 'chat', messageId: 'two', text: 'Three\nFour\n' })
    player = draw()
    expect(player.current?.id).toBe('one')
    expect(player.pinned).toBe(false)
    player.advance()
    draw()
    player = draw()
    expect(player.ended).toBe(true)
    expect(player.beat?.kind).toBe('choices')
    // 下一条仍在生成时，过时选项也允许建立正常的自动推进定时器。
    player.setAuto(true)
    player = draw()
    expect(timers).toHaveLength(1)
    player.setAuto(false)
    player = draw()
    player.advance()
    draw()
    player = draw()
    expect(player.current?.id).toBe('two')
    expect(player.streaming).toBe(true)
    expect(player.pinned).toBe(false)
    // 流式结束后末拍等待语音，自动延迟结束才跨到下一条。
    Object.assign(useStreaming.getInitialState(), previousStreaming)
    second.status = 'done'
    player.replay('one')
    player = draw()
    expect(player.pinned).toBe(true)
    expect(player.replayToken).toBe(1)
    player.jumpToEnd()
    player = draw()
    player.setAuto(true)
    useVnVoiceStore.getInitialState().busyKey = 'one#1:1'
    player = draw()
    expect(timers).toHaveLength(0)
    useVnVoiceStore.getInitialState().busyKey = null
    player = draw()
    expect(timers).toHaveLength(1)
    timers[0]!()
    player = draw()
    expect(player.current?.id).toBe('two')
    // 独立验证本轮队列的自动模式，不能借 pinned 跨消息。
    values.length = 0
    refs.length = 0
    draw()
    player = draw()
    player.jumpToEnd()
    player.setAuto(true)
    useVnVoiceStore.getInitialState().busyKey = 'one#1:1'
    player = draw()
    expect(player.pinned).toBe(false)
    expect(timers).toHaveLength(0)
    useVnVoiceStore.getInitialState().busyKey = null
    player = draw()
    expect(timers).toHaveLength(1)
    timers[0]!()
    player = draw()
    expect(player.current?.id).toBe('two')
    expect(player.pinned).toBe(false)
    player.jumpToEnd()
    player = draw()
    expect(player.beat).toEqual({ kind: 'choices', options: [{ text: 'Last choice' }] })
    expect(timers).toHaveLength(0)
    player.advance()
    player = draw()
    expect(player.current?.id).toBe('two')
    expect(player.beat?.kind).toBe('choices')
    // 已经读完的回复不重新排队，推进时直接进入后面的未读回复。
    values.length = 0
    refs.length = 0
    useVn.getInitialState().read.push('two#1:1')
    options.messages.push({ ...second, id: 'three' })
    draw()
    player = draw()
    player.jumpToEnd()
    player = draw()
    player.advance()
    player = draw()
    expect(player.current?.id).toBe('three')
    expect(player.pinned).toBe(false)
    options.messages.pop()
    // 模拟刷新：服务器拉回来的旧回复按 openedAt 停在最新回复的末拍。
    values.length = 0
    refs.length = 0
    first.createdAt = 1
    second.createdAt = 2
    draw()
    player = draw()
    expect(player.current?.id).toBe('two')
    expect(player.index).toBe(1)
    expect(player.ended).toBe(true)
  } finally {
    qc.clear()
    state.mockRestore()
    ref.mockRestore()
    effect.mockRestore()
    timeout.mockRestore()
    Object.assign(useStreaming.getInitialState(), previousStreaming)
    useVn.getInitialState().read.splice(0, Number.POSITIVE_INFINITY, ...previousRead)
    useVnVoiceStore.getInitialState().busyKey = null
  }
})
