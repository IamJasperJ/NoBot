import { expect, spyOn, test } from 'bun:test'
import { QueryObserver } from '@tanstack/react-query'
import { queryClient } from '../api/queryClient'
import { applyLanguage, getLanguage } from './index'

test('切换语言使全部缓存失效，活跃查询立即重取，未挂载查询下次读取时重取', async () => {
  const originalLanguage = getLanguage()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { lang: '' } } })
  const unsubscribe: (() => void)[] = []
  const invalidate = spyOn(queryClient, 'invalidateQueries')
  try {
    applyLanguage('zh')
    invalidate.mockClear()
    const activeKeys = [['playPresets'], ['chat', 'language-cache'], ['extensions']]
    for (const queryKey of activeKeys) {
      queryClient.setQueryData(queryKey, { label: '中文标签' })
      const observer = new QueryObserver(queryClient, {
        queryKey,
        staleTime: Infinity,
        queryFn: async () => ({ label: getLanguage() === 'en' ? 'English label' : '中文标签' }),
      })
      unsubscribe.push(observer.subscribe(() => {}))
    }
    const inactiveOptions = {
      queryKey: ['character', 'language-cache'],
      staleTime: Infinity,
      queryFn: async () => ({ language: getLanguage() }),
    }
    queryClient.setQueryData(inactiveOptions.queryKey, { language: 'zh' })

    applyLanguage('en')
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith()
    await invalidate.mock.results[0]?.value
    for (const queryKey of activeKeys) {
      expect(queryClient.getQueryData(queryKey)).toEqual({ label: 'English label' })
    }
    expect(queryClient.getQueryState(inactiveOptions.queryKey)?.isInvalidated).toBe(true)
    expect(await queryClient.fetchQuery(inactiveOptions)).toEqual({ language: 'en' })

    applyLanguage('en')
    expect(invalidate).toHaveBeenCalledTimes(1)
  } finally {
    for (const stop of unsubscribe) stop()
    queryClient.clear()
    invalidate.mockRestore()
    applyLanguage(originalLanguage)
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})
