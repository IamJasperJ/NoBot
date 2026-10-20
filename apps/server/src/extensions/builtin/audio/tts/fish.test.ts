import { expect, spyOn, test } from 'bun:test'
import { createTtsEngines } from './engines'
import { createFishClient, fishApiRoot } from './fish'
import { audioSettings } from './settings'

function fetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return Object.assign(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init), {
    preconnect: fetch.preconnect,
  }) as typeof fetch
}
const settings = audioSettings.parse({
  fishApiKey: ' key ',
  fishVoices: [
    { id: 'a', name: '手填' },
    { id: 'a', name: '重复' },
    { id: '', name: '无效' },
  ],
})

test('Fish 根地址保留自建路径，去掉 TTS 后缀与尾斜线', () => {
  expect(fishApiRoot('https://api.fish.audio/v1/tts')).toBe('https://api.fish.audio')
  expect(fishApiRoot('https://custom.example/proxy/v1/tts///')).toBe('https://custom.example/proxy')
  expect(fishApiRoot('https://custom.example/proxy/')).toBe('https://custom.example/proxy')
})

test('Fish voices 合并去重、手填优先、分页上限为五页，缓存隔离与到期', async () => {
  let calls = 0
  let now = 0
  const client = createFishClient({
    mock: false,
    now: () => now,
    fetch: fetchMock((url, init) => {
      calls++
      const params = new URL(url).searchParams
      expect(params.get('self')).toBe('true')
      expect(params.get('page_size')).toBe('100')
      expect(Number(params.get('page_number'))).toBe(((calls - 1) % 5) + 1)
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${calls <= 15 ? 'key' : 'other'}`)
      return Response.json({
        items: [{ _id: 'a', title: '上游' }, { _id: `b${params.get('page_number')}` }],
        has_more: true,
      })
    }),
  })
  expect(await client.voices(settings)).toEqual([
    { value: 'a', label: '手填' },
    ...Array.from({ length: 5 }, (_, i) => ({ value: `b${i + 1}`, label: `b${i + 1}` })),
  ])
  expect(calls).toBe(5)
  await client.voices({ ...settings, fishVoices: [] })
  expect(calls).toBe(5)
  now = 300000
  await client.voices(settings)
  expect(calls).toBe(10)
  await client.voices({ ...settings, fishEndpoint: 'https://custom.example/v1/tts' })
  expect(calls).toBe(15)
  await client.voices({ ...settings, fishApiKey: 'other' })
  expect(calls).toBe(20)
  client.clearCache()
  await client.voices({ ...settings, fishApiKey: 'other' })
  expect(calls).toBe(25)
})

test('Fish engines 使用注入 fetch，失败仅警告并回退，不缓存失败；离线与空密钥不请求', async () => {
  let calls = 0
  const network = fetchMock(() => {
    calls++
    return new Response('secret', { status: 500 })
  })
  const warn = spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const engines = createTtsEngines({ mock: false, fetch: network })
    expect(await engines.fish.voices(settings)).toEqual([{ value: 'a', label: '手填' }])
    await engines.fish.voices(settings)
    expect(calls).toBe(2)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret')
    await createFishClient({ mock: true, fetch: network }).voices(settings)
    await engines.fish.voices({ ...settings, fishApiKey: '' })
    expect(calls).toBe(2)
  } finally {
    warn.mockRestore()
  }
})

test('Fish 搜索映射参数、归一化坏数据、收藏或点赞优先，不跨页排序', async () => {
  const client = createFishClient({
    mock: false,
    fetch: fetchMock((url, init) => {
      expect(new URL(url).pathname).toBe('/proxy/model')
      expect(Object.fromEntries(new URL(url).searchParams)).toEqual({
        title: '声音',
        language: 'zh',
        self: 'false',
        page_number: '3',
        page_size: '25',
      })
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer key')
      return Response.json({
        total: 99,
        has_more: true,
        items: [
          null,
          {},
          { _id: 2 },
          { _id: '' },
          {
            _id: 'plain',
            languages: ['en', null, 2],
            tags: null,
            samples: [null, {}, { audio: 'https://sample' }],
            author: null,
          },
          {
            _id: 'marked',
            marked: true,
            title: '收藏',
            description: '描述',
            author: { nickname: '作者' },
            cover_image: 'https://cover',
            tags: ['tag'],
          },
          { _id: 'liked', liked: true },
        ],
      })
    }),
  })
  const result = await client.search(
    { ...settings, fishEndpoint: 'https://custom.example/proxy/v1/tts' },
    {
      query: '声音',
      language: 'zh',
      self: false,
      page: 3,
      pageSize: 25,
    },
  )
  expect(result).toMatchObject({ total: 99, hasMore: true })
  expect(result.items.map((item) => item.id)).toEqual(['marked', 'liked', 'plain'])
  expect(result.items[0]).toMatchObject({
    title: '收藏',
    author: '作者',
    description: '描述',
    coverUrl: 'https://cover',
    tags: ['tag'],
  })
  expect(result.items[2]).toEqual({
    id: 'plain',
    title: 'plain',
    description: '',
    author: '',
    languages: ['en'],
    tags: [],
    coverUrl: null,
    sampleUrl: 'https://sample',
    liked: false,
    marked: false,
  })
})

test('Fish 无密钥为 400，上游错误与坏 JSON 统一为 502，不能暴露正文', async () => {
  for (const response of [new Response('sensitive-key', { status: 403 }), new Response('sensitive-key')]) {
    const client = createFishClient({ mock: false, fetch: fetchMock(() => response) })
    await expect(client.search({ ...settings, fishApiKey: '' }, {})).rejects.toMatchObject({ status: 400 })
    try {
      await client.search(settings, {})
      throw new Error('应当失败')
    } catch (error) {
      expect(error).toMatchObject({ status: 502 })
      expect(String(error)).not.toContain('sensitive-key')
    }
  }
})

test('Fish 搜索默认分页，离线搜索不访问上游', async () => {
  let calls = 0
  const network = fetchMock((url) => {
    calls++
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual({ page_size: '20', page_number: '1' })
    return Response.json({})
  })
  expect(await createFishClient({ mock: false, fetch: network }).search(settings, {})).toEqual({
    items: [],
    total: 0,
    hasMore: false,
  })
  expect(await createFishClient({ mock: true, fetch: network }).search(settings, {})).toEqual({
    items: [],
    total: 0,
    hasMore: false,
  })
  expect(calls).toBe(1)
})

test('Fish has_more 为空时按 total 补全分页，清缓存期间的旧请求不能回填', async () => {
  let calls = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const client = createFishClient({
    mock: false,
    fetch: fetchMock(async () => {
      calls++
      if (calls === 1) await gate
      return Response.json({ items: [{ _id: 'a' }], total: 101, has_more: null })
    }),
  })
  const pending = client.voices(settings)
  client.clearCache()
  release!()
  await pending
  expect(calls).toBe(2)
  await client.voices(settings)
  expect(calls).toBe(4)
  await client.voices(settings)
  expect(calls).toBe(4)
})
