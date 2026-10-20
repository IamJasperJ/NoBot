import { expect, spyOn, test } from 'bun:test'
import type { SpriteJobDTO, TemporaryActorDTO } from '@nobot/shared'
import type { QueryObserverOptions } from '@tanstack/react-query'
import * as React from 'react'
import { api } from './client'
import { setupHooks } from './hooks.test-utils'
import { keys, useSpriteCutoutJob, useStartSpriteCutout } from './queries'
import { temporaryActorsKey, useCutoutTemporaryActor } from './temporaryActors'

test('重新抠图 hooks：轮询终止、完成失效及临时立绘缓存', async () => {
  const { qc, render } = setupHooks()
  const effects: React.EffectCallback[] = []
  const effect = spyOn(React, 'useEffect').mockImplementation((callback) => {
    effects.push(callback)
  })
  const running: SpriteJobDTO = { total: 2, done: 0, failed: 0, status: 'running' }
  const start = spyOn(api, 'startSpriteCutout').mockResolvedValue({ ...running, jobId: 'job' })
  const job = spyOn(api, 'spriteCutoutJob').mockResolvedValue(running)
  const actor: TemporaryActorDTO = {
    key: 'npc',
    name: 'NPC',
    image: null,
    prompt: '',
    status: 'done',
    updatedAt: 3,
    hasOriginal: true,
  }
  const cutout = spyOn(api, 'cutoutTemporaryActor').mockResolvedValue(actor)
  try {
    await render(() => useStartSpriteCutout('actor')).mutateAsync({ ids: ['sprite'], mode: 'algorithm' })
    expect(start).toHaveBeenCalledWith('actor', ['sprite'], 'algorithm')
    const query = render(() => useSpriteCutoutJob('actor', 'job'))
    await query.refetch()
    const cached = qc.getQueryCache().find<SpriteJobDTO>({ queryKey: ['spriteCutoutJob', 'actor', 'job'] })!
    const interval = (cached.options as QueryObserverOptions<SpriteJobDTO>).refetchInterval
    if (typeof interval !== 'function') throw new Error('缺少轮询配置')
    expect(interval(cached)).toBe(1000)
    for (const status of ['done', 'error'] as const) {
      job.mockResolvedValue({ ...running, status })
      await query.refetch()
      qc.setQueryData(keys.sprites('actor'), [])
      qc.setQueryData(keys.sprites('other'), [])
      effects.length = 0
      render(() => useSpriteCutoutJob('actor', 'job'))
      for (const callback of effects) callback()
      expect(interval(cached)).toBe(false)
      expect(qc.getQueryState(keys.sprites('actor'))?.isInvalidated).toBe(true)
      expect(qc.getQueryState(keys.sprites('other'))?.isInvalidated).toBe(false)
    }
    qc.setQueryData(temporaryActorsKey('chat'), [{ ...actor, updatedAt: 1 }])
    qc.setQueryData(temporaryActorsKey('other'), [])
    await render(() => useCutoutTemporaryActor('chat')).mutateAsync({ key: 'npc', mode: 'model' })
    expect(cutout).toHaveBeenCalledWith({ chatId: 'chat', key: 'npc', mode: 'model' })
    expect(qc.getQueryData(temporaryActorsKey('chat'))).toEqual([actor])
    expect(qc.getQueryState(temporaryActorsKey('other'))?.isInvalidated).toBe(false)
  } finally {
    effect.mockRestore()
    start.mockRestore()
    job.mockRestore()
    cutout.mockRestore()
    qc.clear()
  }
})

test('重抠客户端：预览 Blob、编码路径和统一错误', async () => {
  const calls: { url: string; body: unknown }[] = []
  let fail = false
  const mock = spyOn(globalThis, 'fetch').mockImplementation((async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    return fail
      ? Response.json({ error: { code: 'MATTING_NOT_READY', message: '模型未安装' } }, { status: 400 })
      : new Response('png', { headers: { 'Content-Type': 'image/png' } })
  }) as typeof fetch)
  try {
    expect(await (await api.spriteCutoutPreview('a /', 'b /', 'algorithm')).text()).toBe('png')
    expect(calls.at(-1)).toEqual({
      url: '/api/characters/a%20%2F/sprites/b%20%2F/cutout/preview',
      body: { mode: 'algorithm' },
    })
    expect(await (await api.temporaryActorCutoutPreview({ chatId: 'chat', key: 'npc', mode: 'model' })).text()).toBe(
      'png',
    )
    expect(calls.at(-1)?.body).toEqual({ chatId: 'chat', key: 'npc', mode: 'model', preview: true })
    fail = true
    await expect(api.spriteCutoutPreview('a', 'b', 'model')).rejects.toMatchObject({
      code: 'MATTING_NOT_READY',
      status: 400,
      message: '模型未安装',
    })
    await expect(api.temporaryActorCutoutPreview({ chatId: 'chat', key: 'npc', mode: 'model' })).rejects.toMatchObject({
      status: 400,
    })
  } finally {
    mock.mockRestore()
  }
})
