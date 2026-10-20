import { expect, spyOn, test } from 'bun:test'
import { profileImageSchema } from '@nobot/shared'
import type { QueryObserverOptions } from '@tanstack/react-query'
import { api } from './client'
import { extension, setupHooks } from './hooks.test-utils'
import { useComfyWorkflowOptions, useConnectionModels, useImageModels, useImageStyleOptions } from './profileModels'
import { keys } from './queries'

test('模型 hooks 缓存五分钟、空连接不请求、刷新返回列表，图片缓存区分连接和地址', async () => {
  const { qc, render } = setupHooks()
  const connection = spyOn(api, 'connectionModels').mockResolvedValue(['chat'])
  const image = spyOn(api, 'imageModels').mockResolvedValue([{ value: 'image', label: 'Image' }])
  const workflows = spyOn(api, 'comfyWorkflowOptions').mockResolvedValue([{ value: '', label: '默认' }])
  const styles = spyOn(api, 'imageStyleOptions').mockResolvedValue([{ value: 'style', label: 'Style' }])
  try {
    const empty = render(() => useConnectionModels(null, true))
    await empty.refetch()
    expect(connection).not.toHaveBeenCalled()
    const models = render(() => useConnectionModels('saved', true))
    expect((await models.refetch()).data).toEqual(['chat'])
    const cached = qc.getQueryCache().find({ queryKey: ['connectionModels', 'saved'] })!
    expect((cached.options as QueryObserverOptions).staleTime).toBe(300000)
    render(() => useConnectionModels('saved', false))
    expect((cached.options as QueryObserverOptions).enabled).toBe(false)
    for (const values of [
      { source: 'openai', connectionId: 'first' },
      { source: 'openai', connectionId: 'second' },
      { source: 'comfy', url: 'http://comfy' },
    ]) {
      const config = profileImageSchema.parse(values)
      expect((await render(() => useImageModels(config, true)).refetch()).data).toEqual([
        { value: 'image', label: 'Image' },
      ])
    }
    expect(qc.getQueryCache().findAll({ queryKey: ['imageModels'] })).toHaveLength(3)
    const config = profileImageSchema.parse({ source: 'comfy' })
    const disabled = render(() => useImageModels(config, false))
    const disabledCache = qc.getQueryCache().find({ queryKey: ['imageModels', 'comfy', null, '', config, undefined] })!
    expect((disabledCache.options as QueryObserverOptions).enabled).toBe(false)
    expect(disabled.isFetching).toBe(false)
    qc.setQueryData(keys.extensions, [{ ...extension, id: 'image-gen', settings: { source: 'a1111' } }])
    await render(() => useImageModels(null, true)).refetch()
    expect(image).toHaveBeenLastCalledWith(null, undefined, 'a1111')

    expect((await render(useComfyWorkflowOptions).refetch()).data?.[0]?.value).toBe('')
    expect((await render(useImageStyleOptions).refetch()).data?.[0]?.value).toBe('style')
  } finally {
    connection.mockRestore()
    image.mockRestore()
    workflows.mockRestore()
    styles.mockRestore()
    qc.clear()
  }
})
