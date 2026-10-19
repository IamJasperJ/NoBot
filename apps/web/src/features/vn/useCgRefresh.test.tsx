import { expect, spyOn, test } from 'bun:test'
import type { MessageDTO } from '@nobot/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { keys } from '../../api/queries'
import { useCgRefresh } from './useCgRefresh'

// 服务端渲染不运行 effect；捕获回调，手动模拟提交与卸载以检查定时器生命周期。
test('pending 每 2.5 秒刷新当前会话，完成、失败、切换与卸载清理', async () => {
  const effects: React.EffectCallback[] = []
  const effect = spyOn(React, 'useEffect').mockImplementation((callback) => {
    effects.push(callback)
  })
  const timers = spyOn(globalThis, 'setInterval')
  const clear = spyOn(globalThis, 'clearInterval')
  const qc = new QueryClient()
  const invalidate = spyOn(qc, 'invalidateQueries').mockResolvedValue()
  let tick: (() => void) | undefined
  timers.mockImplementation(((callback: () => void) => {
    tick = callback
    return 123
  }) as typeof setInterval)
  const cleanup: { current: ReturnType<React.EffectCallback> } = { current: undefined }
  function render(chatId: string, status?: 'pending' | 'done' | 'error') {
    const message = status ? ({ meta: { cg: [{ status }] } } as MessageDTO) : undefined
    function Probe() {
      useCgRefresh(chatId, message)
      return null
    }
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    )
    if (cleanup.current) cleanup.current()
    cleanup.current = effects.at(-1)?.()
  }
  try {
    render('a', 'pending')
    expect(timers.mock.calls.at(-1)?.[1]).toBe(2500)
    tick?.()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.chat('a') })
    render('b', 'pending')
    expect(clear).toHaveBeenCalledWith(123)
    tick?.()
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: keys.chat('b') })
    for (const status of ['done', 'error', undefined] as const) {
      const count = timers.mock.calls.length
      render('b', status)
      expect(timers.mock.calls.length).toBe(count)
    }
    render('a', 'pending')
    if (cleanup.current) cleanup.current()
    expect(clear).toHaveBeenCalledTimes(3)
  } finally {
    effect.mockRestore()
    timers.mockRestore()
    clear.mockRestore()
    invalidate.mockRestore()
    qc.clear()
  }
})
