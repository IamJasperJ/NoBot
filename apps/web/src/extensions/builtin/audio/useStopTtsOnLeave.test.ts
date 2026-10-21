import { expect, spyOn, test } from 'bun:test'
import * as React from 'react'
import { ttsPlayer, useTtsPlayer } from './tts-player'
import { getVisibleTtsChat, useStopTtsOnLeave } from './useStopTtsOnLeave'

test('离开 hook 在 chatId 变化和卸载时停止旧会话，同一会话刷新不停止', async () => {
  let previous: React.DependencyList | undefined
  let cleanup: (() => void) | undefined
  const effect = spyOn(React, 'useEffect').mockImplementation((callback, deps) => {
    if (previous && deps?.every((value, i) => value === previous?.[i])) return
    cleanup?.()
    previous = deps
    cleanup = callback() || undefined
  })
  const stop = spyOn(ttsPlayer, 'stopChat').mockImplementation(() => {})
  try {
    useStopTtsOnLeave('a')
    const first = getVisibleTtsChat()
    expect(first?.chatId).toBe('a')
    useStopTtsOnLeave('a')
    expect(getVisibleTtsChat()).toBe(first)
    expect(stop).not.toHaveBeenCalled()
    useStopTtsOnLeave('b')
    expect(stop).toHaveBeenLastCalledWith('a')
    expect(getVisibleTtsChat()?.chatId).toBe('b')
    cleanup?.()
    cleanup = undefined
    expect(stop.mock.calls).toEqual([['a'], ['b']])
    expect(getVisibleTtsChat()).toBeNull()
  } finally {
    cleanup?.()
    effect.mockRestore()
    stop.mockRestore()
  }
})

test('单参数 speakMessage 在请求发出前捕获可见会话，离开即取消请求', async () => {
  let cleanup: (() => void) | undefined
  const effect = spyOn(React, 'useEffect').mockImplementation((callback) => {
    cleanup = callback() || undefined
  })
  const { ttsApi } = await import('../../../api/tts')
  let resolve!: (value: Awaited<ReturnType<typeof ttsApi.message>>) => void
  let signal: AbortSignal | undefined
  const message = spyOn(ttsApi, 'message').mockImplementation((_id, requestSignal) => {
    signal = requestSignal
    return new Promise((r) => {
      resolve = r
    })
  })
  const line = spyOn(ttsApi, 'line')
  try {
    useStopTtsOnLeave('a')
    const task = ttsPlayer.speakMessage('m')
    expect(useTtsPlayer.getState().chatId).toBe('a')
    cleanup?.()
    cleanup = undefined
    expect(signal?.aborted).toBe(true)
    resolve({ chatId: 'a', segments: [{ speaker: { kind: 'narrator' }, text: 'late' }] })
    await task
    expect(line).not.toHaveBeenCalled()
  } finally {
    cleanup?.()
    ttsPlayer.stop()
    effect.mockRestore()
    message.mockRestore()
    line.mockRestore()
  }
})
