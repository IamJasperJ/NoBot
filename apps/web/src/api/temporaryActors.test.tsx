import { expect, spyOn, test } from 'bun:test'
import type { TemporaryActorDTO } from '@nobot/shared'
import type { QueryObserverOptions } from '@tanstack/react-query'
import * as React from 'react'
import { api } from './client'
import { setupHooks } from './hooks.test-utils'
import { keys, useChatPages } from './queries'
import {
  temporaryActorsKey,
  useRegenerateTemporaryActor,
  useRemoveTemporaryActor,
  useTemporaryActors,
  useUploadTemporaryActor,
} from './temporaryActors'

const record: TemporaryActorDTO = {
  key: 'merchant',
  name: 'Merchant',
  image: null,
  prompt: '',
  status: 'pending',
  updatedAt: 1,
}

test('消息临时立绘生成完成或失败时，刷新立绘及所有会话的舞台缓存', () => {
  const { qc, render, page } = setupHooks()
  const effects: React.EffectCallback[] = []
  const effect = spyOn(React, 'useEffect').mockImplementation((callback) => {
    effects.push(callback)
  })
  const stageKeys = [
    ['vn-stage', 'chat', 'reply'],
    ['vn-stage', 'other', 'older-reply'],
  ]
  try {
    for (const status of ['pending', 'done', 'error'] as const) {
      effects.length = 0
      qc.setQueryData(['sprites', 'actor'], [])
      for (const key of stageKeys) qc.setQueryData(key, {})
      qc.setQueryData(keys.chat('chat'), {
        pages: [
          { ...page, messages: page.messages.map((message) => ({ ...message, meta: { spriteGeneration: status } })) },
        ],
        pageParams: [undefined],
      })
      render(() => useChatPages('chat'))
      for (const callback of effects) callback()
      expect(qc.getQueryState(['sprites', 'actor'])?.isInvalidated).toBe(status !== 'pending')
      for (const key of stageKeys) expect(qc.getQueryState(key)?.isInvalidated).toBe(status !== 'pending')
    }
  } finally {
    effect.mockRestore()
    qc.clear()
  }
})

test('临时立绘 hooks：轮询、完成刷新、mutation 失效及会话隔离', async () => {
  const { qc, render } = setupHooks()
  const list = spyOn(api, 'listTemporaryActors').mockResolvedValue([record])
  const regenerate = spyOn(api, 'regenerateTemporaryActor').mockResolvedValue(record)
  const upload = spyOn(api, 'uploadTemporaryActor').mockResolvedValue({ ...record, status: 'done' })
  const remove = spyOn(api, 'removeTemporaryActor').mockResolvedValue({ ok: true })
  const stageKey = ['vn-stage', 'chat']
  const listKey = temporaryActorsKey('chat')
  const seed = () => {
    qc.setQueryData(keys.chat('chat'), {})
    qc.setQueryData(stageKey, {})
    qc.setQueryData(temporaryActorsKey('other'), [])
  }
  try {
    seed()
    const query = render(() => useTemporaryActors('chat'))
    await query.refetch()
    expect(list).toHaveBeenCalledWith('chat')
    const cached = qc.getQueryCache().find<TemporaryActorDTO[]>({ queryKey: listKey })!
    const interval = (cached.options as QueryObserverOptions<TemporaryActorDTO[]>).refetchInterval
    expect(typeof interval).toBe('function')
    if (typeof interval !== 'function') throw new Error('缺少轮询配置')
    expect(interval(cached)).toBe(2000)
    list.mockResolvedValue([{ ...record, status: 'error' }])
    await query.refetch()
    expect(interval(cached)).toBe(false)
    expect(qc.getQueryState(keys.chat('chat'))?.isInvalidated).toBe(true)
    expect(qc.getQueryState(stageKey)?.isInvalidated).toBe(true)
    seed()
    await query.refetch()
    expect(qc.getQueryState(stageKey)?.isInvalidated).toBe(false)
    qc.setQueryData(listKey, [record])
    list.mockResolvedValue([{ ...record, status: 'done' }])
    await query.refetch()
    expect(qc.getQueryState(stageKey)?.isInvalidated).toBe(true)
    seed()
    await render(useRegenerateTemporaryActor).mutateAsync({ chatId: 'chat', key: record.key, prompt: 'blue eyes' })
    expect(regenerate).toHaveBeenCalledWith({ chatId: 'chat', key: record.key, prompt: 'blue eyes' }, expect.anything())
    expect(qc.getQueryData<TemporaryActorDTO[]>(listKey)?.[0]?.status).toBe('pending')
    expect(qc.getQueryState(listKey)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(keys.chat('chat'))?.isInvalidated).toBe(true)
    expect(qc.getQueryState(stageKey)?.isInvalidated).toBe(true)
    seed()
    const file = new File(['image'], 'sprite.png')
    await render(useUploadTemporaryActor).mutateAsync({ chatId: 'chat', key: record.key, file, removeBackground: true })
    expect(upload).toHaveBeenCalledWith(
      { chatId: 'chat', key: record.key, file, removeBackground: true },
      expect.anything(),
    )
    expect(qc.getQueryState(stageKey)?.isInvalidated).toBe(true)
    expect(qc.getQueryState(keys.chat('chat'))?.isInvalidated).toBe(true)
    expect(qc.getQueryState(listKey)?.isInvalidated).toBe(true)
    for (const purge of [false, true]) {
      seed()
      await render(useRemoveTemporaryActor).mutateAsync({ chatId: 'chat', key: record.key, purge })
      expect(remove).toHaveBeenLastCalledWith({ chatId: 'chat', key: record.key, purge }, expect.anything())
      expect(qc.getQueryState(stageKey)?.isInvalidated).toBe(true)
      expect(qc.getQueryState(keys.chat('chat'))?.isInvalidated).toBe(true)
      expect(qc.getQueryState(listKey)?.isInvalidated).toBe(true)
      expect(qc.getQueryState(temporaryActorsKey('other'))?.isInvalidated).toBe(false)
    }
    seed()
    regenerate.mockRejectedValueOnce(new Error('生成失败'))
    await expect(render(useRegenerateTemporaryActor).mutateAsync({ chatId: 'chat', key: record.key })).rejects.toThrow(
      '生成失败',
    )
    expect(qc.getQueryState(stageKey)?.isInvalidated).toBe(false)
    render(() => useTemporaryActors(''))
    expect(
      (qc.getQueryCache().find({ queryKey: temporaryActorsKey('') })!.options as QueryObserverOptions).enabled,
    ).toBe(false)
  } finally {
    list.mockRestore()
    regenerate.mockRestore()
    upload.mockRestore()
    remove.mockRestore()
    qc.clear()
  }
})

test('临时立绘客户端：JSON 路由和 multipart 字段', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return Response.json(record)
  }) as typeof fetch)
  try {
    await api.listTemporaryActors('chat /?')
    expect(calls.at(-1)?.url).toBe('/api/ext/image-gen/temporary-actors?chatId=chat%20%2F%3F')
    await api.regenerateTemporaryActor({ chatId: 'chat', key: record.key, prompt: 'blue eyes' })
    expect(calls.at(-1)?.url).toEndWith('/temporary-actors/regenerate')
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({
      chatId: 'chat',
      key: record.key,
      prompt: 'blue eyes',
    })
    const file = new File(['image'], 'sprite.png')
    for (const removeBackground of [false, true]) {
      await api.uploadTemporaryActor({ chatId: 'chat', key: record.key, file, removeBackground })
      const call = calls.at(-1)!
      expect(call.url).toEndWith('/temporary-actors/upload')
      expect(call.init?.body).toBeInstanceOf(FormData)
      const form = call.init?.body as FormData
      expect(form.get('file')).toBeInstanceOf(File)
      expect(await (form.get('file') as File).text()).toBe('image')
      expect(form.get('chatId')).toBe('chat')
      expect(form.get('key')).toBe(record.key)
      expect(form.get('removeBackground')).toBe(removeBackground ? 'true' : null)
    }
    await api.removeTemporaryActor({ chatId: 'chat', key: record.key, purge: true })
    expect(calls.at(-1)?.init?.method).toBe('DELETE')
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({ chatId: 'chat', key: record.key, purge: true })
  } finally {
    fetchMock.mockRestore()
  }
})
