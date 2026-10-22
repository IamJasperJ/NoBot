import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CharacterDTO, ChatDTO, MessageDTO } from '@nobot/shared'

// 隔离数据库和 fetch 单例，保证整个后端测试并行运行时不相互污染。
test('翻译扩展：服务、保护标记、路由、命令与真实生成流程', async () => {
  if (!process.env.TRANSLATE_TEST_CHILD) {
    const child = Bun.spawn(
      [process.execPath, 'test', 'apps/server/src/extensions/builtin/translate/translate.test.ts'],
      {
        env: { ...process.env, TRANSLATE_TEST_CHILD: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const timer = setTimeout(() => child.kill(), 40000)
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, `${out}\n${err}`).toBe(0)
    } finally {
      clearTimeout(timer)
    }
    return
  }
  const directory = await mkdtemp(join(tmpdir(), 'nobot-translate-'))
  process.env.DATA_DIR = directory
  let sqlite: typeof import('../../../db/client').sqlite | undefined
  let restore: (() => void) | undefined
  try {
    await (await import('../../../bootstrap')).bootstrap()
    const client = await import('../../../db/client')
    sqlite = client.sqlite
    const { app } = await import('../../../app')
    const { createExtensionHost } = await import('../../host')
    const registry = await import('../../registry')
    const { translationSettings } = await import('./settings')
    const { protect, splitTranslation } = await import('./protection')
    const { translateText, deeplLanguage } = await import('./providers')
    const { loadMessage, loadPath, getChatRow } = await import('../../../services/chats')
    const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = []
    const llmRequests: Record<string, unknown>[] = []
    let fail = false
    let damage = false
    let pause: (() => Promise<void>) | undefined
    const mock = spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = String(input)
          const headers = new Headers(init?.headers)
          const raw = String(init?.body ?? '')
          const body: Record<string, unknown> = raw.startsWith('{')
            ? JSON.parse(raw)
            : Object.fromEntries(new URLSearchParams(raw))
          requests.push({ url, body, headers })
          await pause?.()
          if (fail && !url.includes('/chat/completions')) return new Response('service unavailable', { status: 503 })
          const convert = (text: string) =>
            damage
              ? text.replace(/ZXQ\w+?XZ/g, 'broken')
              : text.replaceAll('Hello', '你好').replaceAll('world', '世界').replaceAll('原文', 'Translated input')
          if (url.includes('/models')) return Response.json({ data: [{ id: 'mock-translate' }] })
          if (url.includes('/chat/completions')) {
            llmRequests.push(body)
            const messages = body.messages as { role: string; content: string }[]
            const isTranslation = messages[0]?.content.includes('Target language:')
            const text = isTranslation ? convert(messages.at(-1)!.content) : 'Hello world'
            if (body.stream) {
              return new Response(
                `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
                { headers: { 'Content-Type': 'text/event-stream' } },
              )
            }
            return Response.json({ choices: [{ message: { content: text }, finish_reason: 'stop' }] })
          }
          if (url.includes('translate.googleapis.com'))
            return Response.json([[[convert(String(body.q)), '', null, null]], null, 'en'])
          if (url.includes('.deepl.com'))
            return Response.json({ translations: [{ text: convert((body.text as string[])[0]!) }] })
          if (url.startsWith('https://deeplx.example')) return Response.json({ data: convert(String(body.text)) })
          if (url.startsWith('https://libre.example')) return Response.json({ translatedText: convert(String(body.q)) })
          if (url.startsWith('https://lingva.example'))
            return Response.json({ translation: convert(decodeURIComponent(url.split('/').at(-1)!)) })
          throw new Error(`Unexpected URL: ${url}`)
        },
        { preconnect: fetch.preconnect },
      ),
    )
    restore = () => mock.mockRestore()
    async function json<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
      const response = await app.request(`/api${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const result: unknown = await response.json()
      expect(response.status, JSON.stringify(result)).toBe(200)
      return result as T
    }
    const actor = await json<CharacterDTO>('/characters', { name: 'Alice', description: 'A friend' })
    const chat = await json<ChatDTO>('/chats', { characterId: actor.id })
    await json('/connections', {
      name: '翻译测试',
      baseUrl: 'https://llm.example/v1',
      apiKey: 'secret',
      model: 'mock-translate',
    })
    const config = translationSettings.parse({
      provider: 'google',
      deeplKey: 'key',
      deeplxUrl: 'https://deeplx.example/',
      libreUrl: 'https://libre.example',
      libreKey: 'libre-secret',
      lingvaUrl: 'https://lingva.example',
    })
    const input =
      '<show who="Alice" expression="joy">\nAlice[joy]：Hello {{user}} [smile] https://example.com/x\n\n```ts\nconst name = "Hello"\n```\n\nHello world'
    for (const provider of ['google', 'deepl', 'deeplx', 'libre', 'lingva', 'llm'] as const) {
      const translated = await translateText(input, 'zh-CN', { ...config, provider }, chat.id)
      expect(translated).toBe(
        input.replaceAll('Hello {{user}}', '你好 {{user}}').replaceAll('Hello world', '你好 世界'),
      )
    }
    expect(deeplLanguage('zh-CN')).toBe('ZH-HANS')
    expect(deeplLanguage('zh-TW')).toBe('ZH-HANT')
    expect(deeplLanguage('en')).toBe('EN-US')
    expect(deeplLanguage('ja')).toBe('JA')
    const google = requests.find((entry) => entry.url.includes('googleapis'))!
    expect(new URL(google.url).searchParams.get('client')).toBe('gtx')
    expect(new URL(google.url).searchParams.get('tl')).toBe('zh-CN')
    expect(google.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded')
    const deepl = requests.find((entry) => entry.url.includes('api-free.deepl.com'))!
    expect(deepl.headers.get('Authorization')).toBe('DeepL-Auth-Key key')
    expect(deepl.body.target_lang).toBe('ZH-HANS')
    expect(requests.find((entry) => entry.url.includes('deeplx.example'))!.body).toMatchObject({
      source_lang: 'auto',
      target_lang: 'ZH-HANS',
    })
    expect(requests.find((entry) => entry.url.includes('libre.example'))!.body).toMatchObject({
      source: 'auto',
      target: 'zh',
      api_key: 'libre-secret',
      format: 'text',
    })
    await translateText('Hello', 'zh-TW', { ...config, provider: 'libre' })
    expect(requests.at(-1)!.body.target).toBe('zt')
    await translateText('Hello', 'en', { ...config, provider: 'deepl', deeplEndpoint: 'pro' })
    expect(requests.at(-1)!.url).toContain('https://api.deepl.com/')
    const protectedText = protect(input)
    expect(protectedText.restore(protectedText.text)).toBe(input)
    const complexTags = '<show who="Hello > world" note=\'Hello < world\'>Hello<!-- Hello > world -->'
    expect(await translateText(complexTags, 'en', config)).toBe(
      '<show who="Hello > world" note=\'Hello < world\'>你好<!-- Hello > world -->',
    )
    const whitespace = 'Hello\r\n \t\r\n\r\n  Hello\n\n\t'
    expect(await translateText(whitespace, 'en', config)).toBe(whitespace.replaceAll('Hello', '你好'))
    expect(() => protectedText.restore(protectedText.text.replace(protectedText.tokens[0]!, ''))).toThrow('保护标记')
    expect(() => protectedText.restore(protectedText.text + protectedText.tokens[0])).toThrow('保护标记')
    expect(
      splitTranslation('a'.repeat(4990) + protectedText.tokens[0] + '😀'.repeat(50), 5000, protectedText.tokens).join(
        '',
      ),
    ).toContain(protectedText.tokens[0]!)
    damage = true
    await expect(translateText(input, 'en', config)).rejects.toMatchObject({ code: 'TRANSLATION_TOKEN' })
    damage = false
    for (const [provider, limit] of [
      ['google', 5000],
      ['deepl', 1500],
    ] as const) {
      const before = requests.length
      const long = 'a'.repeat(limit * 2 + 1)
      expect(await translateText(long, 'en', { ...config, provider })).toBe(long)
      const chunks = requests.slice(before)
      expect(chunks).toHaveLength(3)
      for (const chunk of chunks)
        expect(
          String(provider === 'google' ? chunk.body.q : (chunk.body.text as string[])[0]).length,
        ).toBeLessThanOrEqual(limit)
    }
    expect(await translateText(' \n\n\t\n ', 'en', config)).toBe(' \n\n\t\n ')
    client.setSetting('extensionsEnabled', { translate: true })
    client.setSetting('ext:translate', config)
    const events: import('../../types').ServerEvent[] = []
    const host = createExtensionHost((event) => {
      events.push(event)
      registry.emitServerEvent(event)
    })
    const source = host.appendMessage(chat.id, {
      role: 'assistant',
      speakerId: actor.id,
      content: 'Hello world',
      meta: { reasoning: 'Hello', excluded: true },
    })
    client.setSetting('ext:translate', { ...config, translateReasoning: true })
    const translated = await json<MessageDTO>('/ext/translate/message', { messageId: source.id })
    expect(translated.content).toBe('Hello world')
    expect(translated.meta.translation).toMatchObject({
      direction: 'display',
      lang: 'zh-CN',
      text: '你好 世界',
      reasoning: '你好',
      auto: false,
    })
    expect(translated.meta.excluded).toBe(true)
    expect(translated.meta.translation!.sourceHash).toMatch(/^[a-f0-9]{64}$/)
    // 用户清除已有译文后，之前启动的翻译不能再把它悄悄写回来。
    let resume!: () => void
    let requested!: () => void
    const started = new Promise<void>((resolve) => {
      requested = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      resume = resolve
    })
    pause = () => {
      requested()
      return blocked
    }
    const lateTranslation = app.request('/api/ext/translate/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: source.id }),
    })
    await started
    expect(
      (await json<MessageDTO>('/ext/translate/message', { messageId: source.id }, 'DELETE')).meta.translation,
    ).toBeUndefined()
    pause = undefined
    resume()
    expect((await lateTranslation).status).toBe(409)
    expect(loadMessage(source.id).meta.translation).toBeUndefined()
    const user = host.appendMessage(chat.id, {
      role: 'user',
      content: 'Translated input',
      meta: {
        translation: {
          direction: 'source',
          text: '原文',
          lang: 'auto',
          provider: 'google',
          sourceHash: '',
          auto: true,
        },
      },
    })
    expect((await json<MessageDTO>('/ext/translate/message', { messageId: user.id }, 'DELETE')).content).toBe('原文')
    expect(await json('/ext/translate/text', { text: 'Hello', lang: 'zh-CN' })).toEqual({ text: '你好' })
    expect(
      await json('/ext/translate/test', { settings: { ...config, provider: 'deepl', deeplKey: '••••••••' } }),
    ).toEqual({ text: '你好, 世界!' })
    expect((await json<{ options: unknown[] }>('/ext/translate/connections', {})).options.length).toBeGreaterThan(1)
    expect(await json('/ext/translate/models', { chatId: chat.id, settings: { provider: 'llm' } })).toEqual({
      options: [{ value: 'mock-translate', label: 'mock-translate' }],
    })
    expect(
      await json('/ext/translate/commands/translate', {
        chatId: chat.id,
        args: { lang: 'zh-CN' },
        text: 'Hello world',
      }),
    ).toEqual({ result: '你好 世界' })
    expect(await json('/ext/translate/commands/translate', { chatId: chat.id, args: {}, text: '' })).toEqual({
      result: '你好 世界',
    })
    client.setSetting('ext:translate', { ...config, autoMode: 'both' })
    const { startGeneration, subscribe } = await import('../../../services/generation/generation')
    async function generate(text: string) {
      const job = startGeneration(chat.id, { mode: 'send', text, images: [] })
      await new Promise<void>((resolve) =>
        subscribe(job, (event) => {
          if (event.type === 'complete') resolve()
        }),
      )
      // 回复翻译属于独立事件任务，不阻塞 complete。
      for (let i = 0; i < 100; i++) {
        const last = loadMessage(getChatRow(chat.id).activeLeafId!)
        if (last.meta.translation || fail) return last
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error('translation did not complete')
    }
    const reply = await generate('原文')
    expect(reply.status).toBe('done')
    expect(reply.meta.translation).toMatchObject({ direction: 'display', auto: true, text: '你好 世界' })
    const path = loadPath(reply.id)
    const savedUser = path.findLast((message) => message.role === 'user')!
    expect(savedUser.content).toBe('Translated input')
    expect(savedUser.meta.translation).toMatchObject({ direction: 'source', text: '原文', lang: 'auto', auto: true })
    expect(JSON.stringify(llmRequests.at(-1)!.messages)).toContain('Translated input')
    const { toHistory, loadGenerationContext } = await import('../../../services/generation/context')
    const history = toHistory(loadGenerationContext(chat.id, { requireConnection: true }), reply.id)
    expect(history.find((message) => message.id === reply.id)!.content).toContain('Hello world')
    expect(history.find((message) => message.id === savedUser.id)!.content).toContain('Translated input')
    expect(events.some((event) => event.type === 'message:saved')).toBe(true)
    fail = true
    await expect(translateText('Hello', 'en', config)).rejects.toMatchObject({
      code: 'TRANSLATION_FAILED',
      message: expect.stringContaining('503: service unavailable'),
    })
    const failedReply = await generate('原文失败')
    expect(failedReply.status).toBe('done')
    const failedUser = loadPath(failedReply.id).findLast((message) => message.role === 'user')!
    expect(failedUser.content).toBe('原文失败')
    expect(failedUser.meta.translation).toBeUndefined()
    expect(failedReply.meta.translation).toBeUndefined()
    // 钩子的禁用模式不产生网络请求。
    const before = requests.length
    client.setSetting('ext:translate', { ...config, autoMode: 'none' })
    await (await import('./index')).prepareUserTranslation({ text: 'Hello', meta: {} }, chat.id)
    expect(requests.length).toBe(before)
  } finally {
    restore?.()
    sqlite?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 45000)
