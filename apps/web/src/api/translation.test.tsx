import { expect, spyOn, test } from 'bun:test'
import type { MessageDTO } from '@nobot/shared'
import { InfiniteQueryObserver } from '@tanstack/react-query'
import { registerFreshMessage, useFreshMessages } from '../stores/freshMessages'
import { extension, message, setupHooks } from './hooks.test-utils'
import { keys } from './queries'
import {
  useMessageTranslation,
  useTranslateEnabled,
  useTranslateText,
  useTranslationPending,
  useTranslationView,
} from './translation'

test('翻译 hooks：开关、缓存替换、视图记忆、SHA-256、输入语言与自动翻译刷新', async () => {
  if (!process.env.TRANSLATION_HOOK_TEST_CHILD) {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, TRANSLATION_HOOK_TEST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, out + err).toBe(0)
    return
  }
  const { qc, render, page } = setupHooks()
  const translated: MessageDTO = {
    ...message,
    meta: {
      reasoning: 'Thought',
      translation: {
        direction: 'display',
        text: '你好世界',
        reasoning: '思考',
        sourceHash: new Bun.CryptoHasher('sha256').update(message.content).digest('hex'),
        provider: 'llm',
        lang: 'zh-CN',
      },
    },
  }
  const requests: { url: string; method: string; body: unknown }[] = []
  let fail = false
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input)
        requests.push({
          url,
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        })
        if (fail) return Response.json({ error: { code: 'TRANSLATION_FAILED', message: '翻译失败' } }, { status: 502 })
        if (url.endsWith('/message')) return Response.json(init?.method === 'DELETE' ? message : translated)
        if (url.endsWith('/text')) return Response.json({ text: 'こんにちは' })
        return Response.json({ ...page, messages: [translated] })
      },
      { preconnect: fetch.preconnect },
    ),
  )
  const invalidations = spyOn(qc, 'invalidateQueries')
  // 仓库使用服务端渲染测试 hooks；查询通过真实 InfiniteQueryObserver 模拟挂载后的刷新。
  let unsubscribe: (() => void) | undefined
  try {
    expect(render(useTranslateEnabled)).toBe(false)
    expect(render(() => useTranslationPending(message))).toBe(false)
    qc.setQueryData(keys.extensions, [extension])
    expect(render(useTranslateEnabled)).toBe(true)
    const operations = render(() => useMessageTranslation('chat', message))
    await operations.translate()
    expect(qc.getQueryData<{ pages: { messages: MessageDTO[] }[] }>(keys.chat('chat'))?.pages[0]?.messages[0]).toEqual(
      translated,
    )
    expect(requests.at(-1)).toEqual({
      url: '/api/ext/translate/message',
      method: 'POST',
      body: { messageId: message.id },
    })
    await operations.remove()
    expect(requests.at(-1)?.method).toBe('DELETE')
    expect(
      qc.getQueryData<{ pages: { messages: MessageDTO[] }[] }>(keys.chat('chat'))?.pages[0]?.messages[0]?.meta
        .translation,
    ).toBeUndefined()
    fail = true
    await expect(operations.translate()).rejects.toMatchObject({ code: 'TRANSLATION_FAILED' })
    fail = false
    expect(await render(useTranslateText).translate('你好')).toBe('こんにちは')
    expect(requests.at(-1)).toEqual({
      url: '/api/ext/translate/text',
      method: 'POST',
      body: { text: '你好', lang: 'ja' },
    })
    qc.setQueryData(keys.extensions, [])
    await render(useTranslateText).translate('默认')
    expect(requests.at(-1)?.body).toEqual({ text: '默认', lang: 'en' })
    const view = render(() => useTranslationView(translated))
    expect(view.text).toBe('你好世界')
    expect(view.reasoning).toBe('思考')
    await qc
      .getQueryCache()
      .find({ queryKey: ['translationHash', message.content] })!
      .fetch()
    expect(render(() => useTranslationView(translated)).stale).toBe(false)
    const edited = { ...translated, content: 'edited' }
    render(() => useTranslationView(edited))
    await qc
      .getQueryCache()
      .find({ queryKey: ['translationHash', 'edited'] })!
      .fetch()
    expect(render(() => useTranslationView(edited)).stale).toBe(true)
    // Bun 测试环境可能没有 localStorage；用最小实现验证持久化与不可用的降级行为。
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    const values = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    })
    try {
      view.toggle()
      expect(values.get(`translation:view:${message.id}`)).toBe('false')
      expect(render(() => useTranslationView(translated)).text).toBe(message.content)
      expect(render(() => useTranslationView(translated)).reasoning).toBe('Thought')
      const source = {
        ...translated,
        meta: { translation: { ...translated.meta.translation!, direction: 'source' as const, text: '我写的原文' } },
      }
      render(() => useTranslationView(source)).toggle()
      expect(render(() => useTranslationView(source)).text).toBe('我写的原文')
      expect(render(() => useTranslationView({ ...message, id: 'other' })).showTranslation).toBe(true)
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get: () => {
          throw new Error('blocked')
        },
      })
      const blocked = { ...translated, id: 'blocked' }
      expect(render(() => useTranslationView(blocked)).showTranslation).toBe(true)
      render(() => useTranslationView(blocked)).toggle()
      expect(render(() => useTranslationView(blocked)).showTranslation).toBe(false)
    } finally {
      if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
    qc.setQueryData(keys.extensions, [extension])
    expect(render(() => useTranslationPending(message))).toBe(false)
    registerFreshMessage(message.id)
    expect(render(() => useTranslationPending(message))).toBe(true)
    expect(render(() => useTranslationPending({ ...message, status: 'streaming' }))).toBe(false)
    expect(render(() => useTranslationPending({ ...message, role: 'user' }))).toBe(false)
    expect(render(() => useTranslationPending(translated))).toBe(false)
    qc.setQueryData(keys.extensions, [{ ...extension, settings: { autoMode: 'inputs' } }])
    expect(render(() => useTranslationPending(message))).toBe(false)
    qc.setQueryData(keys.extensions, [extension])
    render(() => useTranslationPending(message))
    const query = qc.getQueryCache().find({ queryKey: ['translationPending', message.chatId, message.id] })!
    expect((query.options as { refetchInterval?: number }).refetchInterval).toBe(2000)
    const observer = new InfiniteQueryObserver(qc, {
      queryKey: keys.chat('chat'),
      queryFn: async () => (await fetch('/api/chats/chat')).json(),
      initialPageParam: undefined,
      getNextPageParam: () => undefined,
      staleTime: Infinity,
    })
    unsubscribe = observer.subscribe(() => {})
    await query.fetch()
    expect(invalidations).toHaveBeenCalledWith({ queryKey: keys.chat('chat') })
    const cached = qc.getQueryData<{ pages: { messages: MessageDTO[] }[] }>(keys.chat('chat'))
    expect(cached?.pages[0]?.messages[0]).toEqual(translated)
    const now = spyOn(Date, 'now').mockReturnValue(Date.now() + 60001)
    expect(render(() => useTranslationPending(message))).toBe(false)
    expect((query.options as { enabled?: boolean }).enabled).toBe(false)
    now.mockRestore()
  } finally {
    unsubscribe?.()
    invalidations.mockRestore()
    fetchMock.mockRestore()
    useFreshMessages.setState({ completedAt: new Map() })
    qc.clear()
  }
})
