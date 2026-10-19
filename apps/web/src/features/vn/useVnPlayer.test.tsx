import { expect, spyOn, test } from 'bun:test'
import { type MessageDTO, playPresetDataSchema } from '@nobot/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useStreaming } from '../../stores/streaming'
import { useVn } from '../../stores/vn'
import { useVnPlayer } from './useVnPlayer'

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
    state.mockRestore()
    effect.mockRestore()
    timeout.mockRestore()
    useVn.getInitialState().read.splice(0, Number.POSITIVE_INFINITY, ...previousRead)
    Object.assign(useStreaming.getInitialState(), previousStreaming)
    qc.clear()
  }
})
