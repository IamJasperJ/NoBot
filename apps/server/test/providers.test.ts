import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Json } from '../src/llm/common'
import type { LlmConnection, StreamChunk } from '../src/llm/types'

let llm: typeof import('../src/llm')
let connections: typeof import('../src/services/connections')
let sqlite: typeof import('../src/db/client').sqlite
let directory: string
const originalFetch = globalThis.fetch
const seen: { url: string; headers: Headers; body: Json }[] = []
let respond: (url: string, init: RequestInit) => Response | Promise<Response>
const conn = (provider: string, options: Record<string, string> = {}): LlmConnection => ({
  provider,
  options,
  baseUrl: 'https://mock.test',
  apiKey: 'secret-key',
  headers: { 'X-Proxy': 'yes' },
})
const tool = {
  type: 'function',
  function: {
    name: 'weather',
    description: 'Get weather.',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  },
}
const body = {
  model: 'gemini-2.5-pro',
  stream: true,
  max_tokens: 4096,
  temperature: 0.7,
  top_p: 0.8,
  top_k: 10,
  min_p: 0.1,
  top_a: 0.2,
  repetition_penalty: 1.1,
  frequency_penalty: 1,
  presence_penalty: 1,
  stop: ['END'],
  tools: [tool],
  messages: [
    { role: 'system', content: 'Follow the instructions.' },
    { role: 'system', content: 'Write in English.' },
    { role: 'assistant', content: 'Hello.' },
    { role: 'user', content: 'Hi.' },
    { role: 'system', content: 'Remember this.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Look.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } },
      ],
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'a', type: 'function', function: { name: 'weather', arguments: '{"city":"X"}' } }],
    },
    { role: 'tool', tool_call_id: 'a', content: 'sunny' },
    { role: 'assistant', content: 'The answer is' },
  ],
}
function sse(events: unknown[]) {
  const data = events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join('')
  // 刻意在任意字节位置切分，验证 SSE 解析不依赖网络分块边界。
  const bytes = new TextEncoder().encode(data)
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
        controller.close()
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}
async function collect(connection: LlmConnection, requestBody: Json = body): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of llm.chatCompletion({ connection, body: requestBody, signal: new AbortController().signal }))
    chunks.push(chunk)
  return chunks
}
const openaiEvents = [
  {
    choices: [
      {
        delta: {
          content: 'hello',
          reasoning_content: 'think',
          tool_calls: [{ index: 0, id: 'call', function: { name: 'weather', arguments: '{"city":' } }],
        },
      },
    ],
  },
  {
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"X"}' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  },
]
const googleEvents = [
  { candidates: [{ content: { parts: [{ thought: true, text: 'think' }, { text: 'hello' }] } }] },
  {
    candidates: [
      { content: { parts: [{ functionCall: { name: 'weather', args: { city: 'X' } } }] }, finishReason: 'STOP' },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 15, thoughtsTokenCount: 5 },
  },
]

describe.skipIf(!process.env.PROVIDERS_TEST_CHILD)('多提供方接口', () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nobot-providers-'))
    process.env.DATA_DIR = directory
    const client = await import('../src/db/client')
    sqlite = client.sqlite
    client.initDatabase()
    llm = await import('../src/llm')
    connections = await import('../src/services/connections')
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input)
      const headers = new Headers(init.headers)
      const parsed = typeof init.body === 'string' ? JSON.parse(init.body) : {}
      seen.push({ url, headers, body: parsed })
      return respond(url, init)
    }) as typeof fetch
  })
  afterEach(() => {
    seen.length = 0
  })
  afterAll(async () => {
    globalThis.fetch = originalFetch
    sqlite.close()
    await rm(directory, { recursive: true, force: true })
  })

  test('Claude 转换 system、合并、图片、工具和 prefill，并解析所有流式事件', async () => {
    respond = () =>
      sse([
        { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'think' } },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'call', name: 'weather', input: {} },
        },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"X"}' } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
        { type: 'message_stop' },
      ])
    const snapshot = JSON.stringify(body)
    const chunks = await collect(conn('claude'))
    const sent = seen[0]!
    expect(sent.url).toBe('https://mock.test/messages')
    expect(sent.headers.get('x-api-key')).toBe('secret-key')
    expect(sent.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(sent.headers.get('X-Proxy')).toBe('yes')
    expect(sent.body.system).toHaveLength(2)
    expect(sent.body.messages[0].role).toBe('user')
    expect(sent.body.messages[2].content).toEqual([
      { type: 'text', text: 'Hi.' },
      { type: 'text', text: 'Remember this.' },
      { type: 'text', text: 'Look.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
    ])
    expect(sent.body.messages[3].content[0]).toMatchObject({ type: 'tool_use', name: 'weather', input: { city: 'X' } })
    expect(sent.body.messages[4].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'a', content: 'sunny' })
    expect(sent.body.messages.at(-1).role).toBe('assistant')
    expect(sent.body.tools[0].input_schema).toEqual(tool.function.parameters)
    expect(sent.body.stop_sequences).toEqual(['END'])
    expect(sent.body.frequency_penalty).toBeUndefined()
    expect(chunks).toContainEqual({ text: 'hello' })
    expect(chunks).toContainEqual({ reasoning: 'think' })
    expect(chunks).toContainEqual({ finishReason: 'tool_use', usage: { promptTokens: 10, completionTokens: 20 } })
    expect(chunks.at(-1)?.toolCalls).toEqual([{ id: 'call', name: 'weather', arguments: '{"city":"X"}' }])
    expect(JSON.stringify(body)).toBe(snapshot)
  })

  test('Claude thinking 默认预算和非流式解析', async () => {
    respond = () =>
      Response.json({
        content: [
          { type: 'text', text: 'hello' },
          { type: 'thinking', thinking: 'think' },
          { type: 'tool_use', id: 'a', name: 'weather', input: {} },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 2 },
      })
    const chunks = await collect(conn('claude'), { ...body, stream: false, max_tokens: 20, reasoning_effort: 'low' })
    expect(seen[0]!.body.max_tokens).toBeGreaterThan(seen[0]!.body.thinking.budget_tokens)
    expect(seen[0]!.body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
    expect(seen[0]!.body.temperature).toBeUndefined()
    expect(seen[0]!.body.messages.at(-1).role).toBe('user')
    expect(chunks[0]).toMatchObject({
      text: 'hello',
      reasoning: 'think',
      finishReason: 'end_turn',
      usage: { promptTokens: 1, completionTokens: 2 },
    })
  })

  for (const provider of ['gemini', 'vertexai'])
    test(`${provider} 图片、工具、system、thinking 转换与流式解析`, async () => {
      respond = () => sse(googleEvents)
      const chunks = await collect(conn(provider, { region: 'europe-west1' }), { ...body, reasoning_effort: 'medium' })
      const sent = seen[0]!
      expect(sent.url).toBe(
        provider === 'gemini'
          ? 'https://mock.test/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse'
          : 'https://mock.test/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
      )
      expect(sent.headers.get('x-goog-api-key')).toBe('secret-key')
      expect(sent.headers.get('X-Proxy')).toBe('yes')
      expect(sent.body.systemInstruction.parts).toHaveLength(2)
      expect(sent.body.contents[1].parts).toContainEqual({ inline_data: { mime_type: 'image/png', data: 'YWJj' } })
      expect(sent.body.contents[2].parts[0]).toEqual({ functionCall: { name: 'weather', args: { city: 'X' } } })
      expect(sent.body.contents[3].parts[0]).toEqual({
        functionResponse: { name: 'weather', response: { result: 'sunny' } },
      })
      expect(sent.body.contents.at(-1).role).toBe('model')
      expect(sent.body.tools[0].functionDeclarations[0].parameters).toEqual(tool.function.parameters)
      expect(sent.body.generationConfig).toMatchObject({
        maxOutputTokens: 4096,
        topP: 0.8,
        topK: 10,
        thinkingConfig: { includeThoughts: true },
      })
      expect(sent.body.safetySettings.every((s: Json) => s.threshold === 'OFF')).toBe(true)
      expect(chunks[0]).toMatchObject({ text: 'hello', reasoning: 'think' })
      expect(chunks[1]).toMatchObject({ finishReason: 'STOP', usage: { promptTokens: 10, completionTokens: 20 } })
      expect(chunks.at(-1)?.toolCalls?.[0]).toMatchObject({ name: 'weather', arguments: '{"city":"X"}' })
    })

  for (const provider of ['custom', 'azure_openai', 'deepseek', 'openrouter', 'workers_ai'])
    test(`${provider} OpenAI 请求与分片工具解析`, async () => {
      respond = () => sse(openaiEvents)
      const chunks = await collect(conn(provider, { deployment: 'my deployment', accountId: '123' }))
      const sent = seen[0]!
      expect(sent.url).toBe(
        provider === 'azure_openai'
          ? 'https://mock.test/openai/deployments/my%20deployment/chat/completions?api-version=2024-10-21'
          : provider === 'workers_ai'
            ? 'https://mock.test/123/ai/v1/chat/completions'
            : 'https://mock.test/chat/completions',
      )
      expect(sent.headers.get(provider === 'azure_openai' ? 'api-key' : 'Authorization')).toBe(
        provider === 'azure_openai' ? 'secret-key' : 'Bearer secret-key',
      )
      if (provider === 'azure_openai') expect(sent.body.model).toBeUndefined()
      else expect(sent.body.messages).toEqual(body.messages)
      if (provider === 'openrouter') {
        expect(sent.headers.get('X-Title')).toBe('NoBot')
        expect(sent.headers.get('HTTP-Referer')).toBeTruthy()
      }
      expect(chunks[0]).toEqual({ text: 'hello', reasoning: 'think' })
      expect(chunks[1]).toMatchObject({ finishReason: 'tool_calls', usage: { promptTokens: 10, completionTokens: 20 } })
      expect(chunks.at(-1)?.toolCalls).toEqual([{ id: 'call', name: 'weather', arguments: '{"city":"X"}' }])
    })

  test('不支持的非标准采样参数过滤且保留原始请求', async () => {
    respond = () => Response.json({ choices: [{ message: { content: 'ok' } }] })
    for (const provider of ['openai', 'mistralai', 'perplexity', 'cohere', 'ai21']) {
      await collect(conn(provider), { ...body, stream: false, include_reasoning: true })
      for (const key of ['top_k', 'min_p', 'top_a', 'repetition_penalty', 'include_reasoning'])
        expect(seen.at(-1)!.body[key]).toBeUndefined()
    }
    expect(body.top_k).toBe(10)
  })

  for (const provider of ['custom', 'claude', 'gemini', 'vertexai', 'azure_openai'])
    test(`${provider} HTTP、响应体和网络错误统一转换`, async () => {
      const c = conn(provider, { deployment: 'test' })
      respond = () => Response.json({ error: { message: 'upstream detail' } }, { status: 401 })
      await expect(collect(c)).rejects.toMatchObject({
        code: 'HTTP_401',
        message: expect.stringContaining('upstream detail'),
      })
      respond = () => Response.json({ error: { message: 'body error' } })
      await expect(collect(c, { ...body, stream: false })).rejects.toMatchObject({ code: 'UPSTREAM' })
      respond = () => sse([{ error: { message: 'stream error' } }])
      await expect(collect(c)).rejects.toMatchObject({ code: 'UPSTREAM' })
      respond = () => {
        throw new TypeError('offline')
      }
      await expect(collect(c)).rejects.toMatchObject({ code: 'NETWORK' })
    })

  test('listModels 静态、OpenAI、Claude、Gemini 分页过滤、Vertex 分支', async () => {
    expect(await llm.listModels(conn('azure_openai'))).toEqual([])
    expect(await llm.listModels(conn('ai21'))).toEqual(['jamba-large', 'jamba-mini'])
    expect(seen).toHaveLength(0)
    respond = () => Response.json({ data: [{ id: 'z' }, { id: 'a' }] })
    expect(await llm.listModels(conn('custom'))).toEqual(['a', 'z'])
    expect(await llm.listModels(conn('claude'))).toEqual(['a', 'z'])
    expect(seen.at(-1)!.headers.get('anthropic-version')).toBe('2023-06-01')
    respond = (url) =>
      Response.json(
        url.includes('pageToken=next')
          ? { models: [{ name: 'models/b', supportedGenerationMethods: ['generateContent'] }] }
          : {
              models: [
                { name: 'models/a', supportedGenerationMethods: ['generateContent'] },
                { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
              ],
              nextPageToken: 'next',
            },
      )
    expect(await llm.listModels(conn('gemini'))).toEqual(['a', 'b'])
    expect(seen.at(-1)!.headers.get('x-goog-api-key')).toBe('secret-key')
    respond = () => Response.json({ publisherModels: [{ name: 'publishers/google/models/gemini' }] })
    expect(await llm.listModels(conn('vertexai'))).toEqual(['gemini'])
    expect(seen.at(-1)!.url).toBe('https://mock.test/v1beta1/publishers/google/models')
  })

  test('Vertex 服务账号 JWT 签名、claims、项目覆盖和 token 缓存', async () => {
    const keys = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )
    const privateKey = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64')
    const c = conn('vertexai', { authMode: 'service_account', region: 'global' })
    c.baseUrl = 'https://aiplatform.googleapis.com'
    c.apiKey = JSON.stringify({
      client_email: 'test@example.com',
      private_key: `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`,
      project_id: 'from-json',
    })
    let exchanges = 0
    respond = async (url, init) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        exchanges++
        const jwt = (init.body as URLSearchParams).get('assertion')!.split('.')
        expect(
          await crypto.subtle.verify(
            'RSASSA-PKCS1-v1_5',
            keys.publicKey,
            Buffer.from(jwt[2]!, 'base64url'),
            new TextEncoder().encode(`${jwt[0]}.${jwt[1]}`),
          ),
        ).toBe(true)
        const claims = JSON.parse(Buffer.from(jwt[1]!, 'base64url').toString())
        expect(claims).toMatchObject({
          iss: 'test@example.com',
          aud: 'https://oauth2.googleapis.com/token',
          scope: 'https://www.googleapis.com/auth/cloud-platform',
        })
        expect(claims.exp - claims.iat).toBe(3600)
        return Response.json({ access_token: 'oauth-token', expires_in: 3600 })
      }
      return Response.json(googleEvents[1])
    }
    await collect(c, { ...body, stream: false })
    expect(seen.at(-1)!.url).toContain('/v1/projects/from-json/locations/global/publishers/google/models/')
    expect(seen.at(-1)!.headers.get('Authorization')).toBe('Bearer oauth-token')
    await collect(
      { ...c, options: { ...c.options, projectId: 'override', region: 'us-central1' } },
      { ...body, stream: false },
    )
    expect(seen.at(-1)!.url).toContain(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/override/locations/us-central1/',
    )
    expect(exchanges).toBe(1)
    await expect(collect({ ...c, apiKey: '{}' })).rejects.toMatchObject({ code: 'AUTH' })
  })

  test('空对话补位、Claude 默认 max_tokens 与 prefill 尾部空白', async () => {
    respond = () => Response.json({ content: [{ type: 'text', text: 'OK' }] })
    await collect(conn('claude'), { model: 'claude', messages: [{ role: 'system', content: 'Write in English.' }] })
    expect(seen.at(-1)!.body.max_tokens).toBe(4096)
    expect(seen.at(-1)!.body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Continue.' }] }])
    await collect(conn('claude'), { ...body, stream: false, messages: [{ role: 'assistant', content: 'Prefix  ' }] })
    expect(seen.at(-1)!.body.messages.at(-1).content[0].text).toBe('Prefix')
    expect(seen.at(-1)!.body.messages[0].role).toBe('user')
  })

  test('模型列表 Claude 分页、循环游标与错误正文截断', async () => {
    respond = (url) =>
      Response.json(
        url.includes('after_id=last')
          ? { data: [{ id: 'b' }] }
          : { data: [{ id: 'a' }], has_more: true, last_id: 'last' },
      )
    expect(await llm.listModels(conn('claude'))).toEqual(['a', 'b'])
    respond = () => Response.json({ models: [], nextPageToken: 'loop' })
    await expect(llm.listModels(conn('gemini'))).rejects.toMatchObject({ code: 'UPSTREAM' })
    respond = () => new Response(`upstream failure ${'x'.repeat(1000)}`, { status: 503 })
    try {
      await llm.listModels(conn('custom'))
      throw new Error('Expected failure')
    } catch (error) {
      expect(error).toBeInstanceOf(llm.LlmError)
      expect((error as Error).message).toContain('upstream failure')
      expect((error as Error).message.length).toBeLessThan(600)
    }
  })

  test('Gemini 非流式、Gemini 3 工具历史和 thinking level', async () => {
    respond = () => Response.json(googleEvents[1])
    const chunks = await collect(conn('gemini'), {
      ...body,
      model: 'gemini-3-flash',
      stream: false,
      reasoning_effort: 'high',
      tool_choice: { type: 'function', function: { name: 'weather' } },
    })
    expect(seen.at(-1)!.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high', includeThoughts: true })
    expect(seen.at(-1)!.body.contents[2].parts[0].thoughtSignature).toBe('skip_thought_signature_validator')
    expect(seen.at(-1)!.body.toolConfig.functionCallingConfig).toEqual({
      mode: 'ANY',
      allowedFunctionNames: ['weather'],
    })
    expect(chunks.at(-1)?.toolCalls?.[0]?.name).toBe('weather')
    expect(seen.at(-1)!.url).toEndWith(':generateContent')
  })

  test('迁移为旧式 SQL 插入提供默认 provider 和 options', () => {
    sqlite.run(
      "INSERT INTO api_presets (id, name, base_url, model, created_at, updated_at) VALUES ('legacy', 'Legacy', 'https://mock.test', 'model', 1, 1)",
    )
    expect(connections.getApiPresetRow('legacy')).toMatchObject({ provider: 'custom', options: {} })
  })

  test('连接 CRUD、PATCH 默认值、打码和静态提供方测试连接', async () => {
    const created = connections.createApiPreset({
      name: 'Vertex',
      provider: 'vertexai',
      options: { authMode: 'service_account' },
      apiKey: '{"private_key":"long secret"}',
      baseUrl: 'https://mock.test',
      model: 'gemini',
    })
    expect(created).toMatchObject({ provider: 'vertexai', options: { authMode: 'service_account' } })
    expect(created.apiKeyMasked).not.toContain('long secret')
    expect(connections.updateApiPreset(created.id, { name: 'Renamed' })).toMatchObject({
      provider: 'vertexai',
      options: { authMode: 'service_account' },
    })
    expect(connections.listApiPresets().find((p) => p.id === created.id)?.provider).toBe('vertexai')
    expect(llm.toLlmConnection(connections.getApiPresetRow(created.id)).options.region).toBe('global')
    connections.updateApiPreset(created.id, {
      provider: 'azure_openai',
      options: { deployment: 'saved-deployment' },
      apiKey: 'saved-secret',
    })
    respond = () => Response.json({ choices: [{ message: { content: 'OK' } }] })
    expect(
      await connections.testConnection({ presetId: created.id, options: { deployment: 'draft-deployment' } }),
    ).toEqual({ ok: true, models: [] })
    expect(seen.at(-1)!.url).toContain('/deployments/draft-deployment/')
    expect(seen.at(-1)!.headers.get('api-key')).toBe('saved-secret')
    respond = () => Response.json({ error: { message: 'invalid key' } }, { status: 401 })
    expect(
      (await connections.testConnection({ provider: 'ai21', baseUrl: 'https://mock.test', apiKey: 'bad' })).ok,
    ).toBe(false)
    const old = connections.createApiPreset({ name: 'Old', baseUrl: 'https://mock.test', model: 'model' })
    expect(old).toMatchObject({ provider: 'custom', options: {} })
  })
})

if (!process.env.PROVIDERS_TEST_CHILD)
  test('提供方测试使用独立数据库进程', async () => {
    const child = Bun.spawn([process.execPath, 'test', 'apps/server/test/providers.test.ts'], {
      env: { ...process.env, PROVIDERS_TEST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, `${out}\n${err}`).toBe(0)
  }, 30000)
