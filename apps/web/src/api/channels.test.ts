import { expect, spyOn, test } from 'bun:test'
import { channelPoliciesSchema } from '@nobot/shared'
import { channelKeys, channelsApi, useChannelAccount, useChannelBindings, useUpdateChannelPolicies } from './channels'
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
