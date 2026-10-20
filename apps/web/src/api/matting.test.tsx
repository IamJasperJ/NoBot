import { expect, spyOn, test } from 'bun:test'
import type { MattingStatus } from '@nobot/shared'
import type { QueryObserverOptions } from '@tanstack/react-query'
import { api } from './client'
import { setupHooks } from './hooks.test-utils'
import { mattingStatusKey, useInstallMatting, useMattingStatus, useRemoveMatting } from './matting'

test('抠图 hooks 只在安装期间轮询，安装和删除更新状态缓存', async () => {
  const { qc, render } = setupHooks()
  const missing: MattingStatus = { runtime: { state: 'missing' }, model: { state: 'missing' } }
  const installing: MattingStatus = {
    runtime: { state: 'ready' },
    model: { state: 'installing', received: 2, total: 4 },
  }
  const status = spyOn(api, 'mattingStatus').mockResolvedValue(missing)
  const install = spyOn(api, 'installMatting').mockResolvedValue(installing)
  const remove = spyOn(api, 'removeMatting').mockResolvedValue(missing)
  try {
    const query = render(() => useMattingStatus(true))
    await query.refetch()
    const cached = qc.getQueryCache().find<MattingStatus>({ queryKey: mattingStatusKey })!
    const interval = (cached.options as QueryObserverOptions<MattingStatus>).refetchInterval
    if (typeof interval !== 'function') throw new Error('缺少轮询配置')
    expect(interval(cached)).toBe(false)
    await render(useInstallMatting).mutateAsync({ mattingRegistry: 'https://registry.invalid' })
    expect(qc.getQueryData(mattingStatusKey)).toEqual(installing)
    expect(interval(cached)).toBe(1000)
    for (const state of ['ready', 'error', 'missing'] as const) {
      qc.setQueryData(mattingStatusKey, { runtime: { state }, model: { state } })
      expect(interval(cached)).toBe(false)
    }
    qc.setQueryData(mattingStatusKey, { runtime: { state: 'installing' }, model: { state: 'ready' } })
    expect(interval(cached)).toBe(1000)
    await render(useRemoveMatting).mutateAsync()
    expect(qc.getQueryData(mattingStatusKey)).toEqual(missing)
    render(() => useMattingStatus(false))
    expect((cached.options as QueryObserverOptions<MattingStatus>).enabled).toBe(false)
  } finally {
    status.mockRestore()
    install.mockRestore()
    remove.mockRestore()
    qc.clear()
  }
})
