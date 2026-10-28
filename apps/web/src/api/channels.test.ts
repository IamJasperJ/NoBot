import { expect, spyOn, test } from 'bun:test'
import { channelPoliciesSchema } from '@nobot/shared'
import {
  channelKeys,
  channelsApi,
  useChannelAccount,
  useChannelBindings,
  useRegenerateChannelIntro,
  useUpdateChannelPolicies,
} from './channels'
import { setupHooks } from './hooks.test-utils'

test('渠道客户端：管理路由、确认标志、凭据和路径编码', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const mock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init })
        return Response.json({ ok: true })
      },
      { preconnect: fetch.preconnect },
    ) as typeof fetch,
  )
  try {
    await channelsApi.accounts()
    await channelsApi.account('bot/id')
    await channelsApi.createAccount({ name: 'Bot', credentials: { token: 'secret' } })
    await channelsApi.updateAccount({ id: 'bot/id', patch: { name: 'Renamed', credentials: '••••••••' } })
    for (const action of ['start', 'stop', 'restart'] as const)
      await channelsApi.accountAction({ id: 'bot/id', action })
    await channelsApi.presencePreview('bot/id')
    await channelsApi.presenceApply({ id: 'bot/id', confirm: true })
    await channelsApi.presenceSync('bot/id')
    await channelsApi.regenerateIntro('bot/id')
    await channelsApi.policies({ id: 'bot/id', policies: channelPoliciesSchema.parse({}), confirm: true })
    await channelsApi.requests('bot/id')
    for (const action of ['approve', 'reject', 'block'] as const)
      await channelsApi.respondRequest({ id: 'request/id', action })
    await channelsApi.bindings('bot/id')
    await channelsApi.binding('binding/id')
    await channelsApi.updateBinding({ id: 'binding/id', patch: { trigger: 'follow-room' } })
    await channelsApi.disableBinding('binding/id')
    await channelsApi.leaveBinding({ id: 'binding/id', confirm: true })
    await channelsApi.settings('binding/id')
    await channelsApi.actors()
    await channelsApi.updateActor({ id: 'actor/id', patch: { role: 'blocked' } })
    await channelsApi.confirmPairing('code')
    await channelsApi.log()
    await channelsApi.testSend({ id: 'bot/id', chat: '1', text: 'Test' })
    await channelsApi.native({ id: 'binding/id', input: { action: 'title', title: 'Table', confirm: true } })
    await channelsApi.deleteAccount('bot/id')
    expect(calls.every((c) => c.init?.credentials === 'include')).toBe(true)
    expect(calls.map((c) => c.url)).toContain('/api/ext/channels/accounts/bot%2Fid/presence/preview')
    expect(calls.map((c) => c.url)).toContain('/api/ext/channels/requests?accountId=bot%2Fid')
    expect(calls.find((c) => c.url.endsWith('/presence/apply'))?.init?.body).toBe('{"confirm":true}')
    expect(calls.find((c) => c.url.endsWith('/native'))?.init?.body).toBe(
      '{"action":"title","title":"Table","confirm":true}',
    )
    expect(
      calls.find((c) => c.url === '/api/ext/channels/accounts/bot%2Fid/presence/regenerate-intro')?.init?.method,
    ).toBe('POST')
    expect(calls.at(-1)?.init?.method).toBe('DELETE')
  } finally {
    mock.mockRestore()
  }
})

test('渠道 hooks：禁用空 id 查询、按账号隔离、修改后刷新渠道/房间/会话缓存', async () => {
  const { qc, render } = setupHooks()
  const policy = spyOn(channelsApi, 'policies').mockResolvedValue(
    {} as Awaited<ReturnType<typeof channelsApi.policies>>,
  )
  try {
    expect(render(() => useChannelAccount('')).fetchStatus).toBe('idle')
    render(() => useChannelBindings('a'))
    render(() => useChannelBindings('b'))
    expect(qc.getQueryCache().find({ queryKey: channelKeys.bindings('a') })).toBeTruthy()
    expect(qc.getQueryCache().find({ queryKey: channelKeys.bindings('b') })).toBeTruthy()
    for (const key of [channelKeys.accounts, ['rooms'], ['chats']]) qc.setQueryData(key, [])
    await render(useUpdateChannelPolicies).mutateAsync({
      id: 'a',
      policies: channelPoliciesSchema.parse({}),
      confirm: true,
    })
    for (const key of [channelKeys.accounts, ['rooms'], ['chats']])
      expect(qc.getQueryState(key)?.isInvalidated).toBe(true)
  } finally {
    policy.mockRestore()
    qc.clear()
  }
})

test('重新生成简介 hook 保存返回预览并刷新角色缓存', async () => {
  const { qc, render } = setupHooks()
  const preview = {
    current: {},
    desired: { description: 'New bio' },
    fields: {},
    languages: { zh: {}, en: {} },
    confirmed: true,
  }
  const mock = spyOn(channelsApi, 'regenerateIntro').mockResolvedValue(preview)
  try {
    qc.setQueryData(['character', 'c'], {})
    qc.setQueryData(['characters'], [])
    expect(await render(useRegenerateChannelIntro).mutateAsync('a')).toEqual(preview)
    expect(qc.getQueryData(channelKeys.presence('a'))).toEqual(preview)
    expect(qc.getQueryState(['character', 'c'])?.isInvalidated).toBe(true)
    expect(qc.getQueryState(['characters'])?.isInvalidated).toBe(true)
  } finally {
    mock.mockRestore()
    qc.clear()
  }
})

test('贴纸数据层：分组、引用预览、集/条目管理和账号缓存', async () => {
  const {
    useChannelStickers,
    useAddStickerSet,
    useRefreshQqFaces,
    useUpdateSticker,
    useDeleteSticker,
    channelStickerPreviewUrl,
  } = await import('./channels')
  const { qc, render } = setupHooks()
  const result = { groups: [], count: 0 }
  const calls: { url: string; init?: RequestInit }[] = []
  const mock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init })
        return Response.json(result)
      },
      { preconnect: fetch.preconnect },
    ),
  )
  try {
    expect(render(() => useChannelStickers('')).fetchStatus).toBe('idle')
    await render(useAddStickerSet).mutateAsync({ accountId: 'a/b', name: 'https://t.me/addstickers/Cats' })
    expect(qc.getQueryData(channelKeys.stickers('a/b'))).toEqual(result)
    await render(useRefreshQqFaces).mutateAsync('a/b')
    await render(useUpdateSticker).mutateAsync({
      accountId: 'a/b',
      id: 'set/id',
      kind: 'sets',
      patch: { enabled: false, characters: ['c'] },
    })
    await render(useDeleteSticker).mutateAsync({ accountId: 'a/b', id: 'face/id' })
    expect(calls.map((call) => call.url)).toEqual([
      '/api/ext/channels/accounts/a%2Fb/stickers/sets',
      '/api/ext/channels/accounts/a%2Fb/stickers/refresh',
      '/api/ext/channels/accounts/a%2Fb/stickers/sets/set%2Fid',
      '/api/ext/channels/accounts/a%2Fb/stickers/entries/face%2Fid',
    ])
    expect(calls.map((call) => call.init?.method)).toEqual(['POST', 'POST', 'PATCH', 'DELETE'])
    expect(channelStickerPreviewUrl('a/b', 's/id')).toBe('/api/ext/channels/accounts/a%2Fb/stickers/s%2Fid/preview')
  } finally {
    mock.mockRestore()
    qc.clear()
  }
})
