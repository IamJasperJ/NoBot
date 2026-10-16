import { afterAll, beforeAll, expect, test } from 'bun:test'
import { aspectRatio, findChatImage, generateOpenAI, openaiApiKind, openaiChatBody } from './backends/openai'
import { parseSettings } from './settings'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const reply = (message: Record<string, unknown>) => ({ choices: [{ message }] })

test('按模型名自动选择接口，可手动指定', () => {
  const settings = (openaiModel: string, openaiApiType = 'auto') => parseSettings({ openaiModel, openaiApiType })
  expect(openaiApiKind(settings('gemini-3.1-flash-image'))).toBe('chat')
  expect(openaiApiKind(settings('nano-banana-pro'))).toBe('chat')
  expect(openaiApiKind(settings('doubao-seedream-4'))).toBe('chat')
  expect(openaiApiKind(settings('gpt-image-2'))).toBe('images')
  expect(openaiApiKind(settings('chatgpt-image-latest'))).toBe('images')
  expect(openaiApiKind(settings('dall-e-3'))).toBe('images')
  expect(openaiApiKind(settings('gpt-image-2', 'chat'))).toBe('chat')
  expect(openaiApiKind(settings('gemini-3.1-flash-image', 'images'))).toBe('images')
})

test('聊天接口请求体：提示词作为用户消息，带画幅比例和图片输出声明，合并额外参数', () => {
  const body = openaiChatBody(
    parseSettings({ openaiModel: 'gemini-3.1-flash-image', openaiExtra: '{"temperature":1}' }),
    '1girl, forest',
    832,
    1216,
  )
  expect(body).toMatchObject({ model: 'gemini-3.1-flash-image', modalities: ['image', 'text'], temperature: 1 })
  expect(body.messages[0]?.content).toContain('1girl, forest')
  expect(body.messages[0]?.content).toContain('Aspect ratio: 13:19')
  expect(aspectRatio(1024, 1536)).toBe('2:3')
})

test('从各种聊天回复格式里找出图片', () => {
  const data = `data:image/png;base64,${png}`
  // OpenRouter：message.images
  expect(findChatImage(reply({ images: [{ type: 'image_url', image_url: { url: data } }] }))).toBe(data)
  // content 数组：image_url / inline_data / Markdown 文本
  expect(findChatImage(reply({ content: [{ type: 'image_url', image_url: { url: data } }] }))).toBe(data)
  expect(findChatImage(reply({ content: [{ inline_data: { mime_type: 'image/jpeg', data: png } }] }))).toBe(
    `data:image/jpeg;base64,${png}`,
  )
  expect(findChatImage(reply({ content: [{ type: 'text', text: `好的 ![图](${data})` }] }))).toBe(data)
  // content 字符串：Markdown、裸 data 地址、图片链接
  expect(findChatImage(reply({ content: `这是图片：\n![image](${data})` }))).toBe(data)
  expect(findChatImage(reply({ content: `${data}` }))).toBe(data)
  expect(findChatImage(reply({ content: '![](https://cdn.example.com/a.png?x=1)' }))).toBe(
    'https://cdn.example.com/a.png?x=1',
  )
  expect(findChatImage(reply({ content: '我不能画这个' }))).toBeNull()
})

// 模拟中转：gemini 模型只能走聊天接口（图片接口返回 400），gpt-image 只能走图片接口
let server: ReturnType<typeof Bun.serve>
const hits: string[] = []
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = (await request.json()) as { model: string }
      hits.push(`${url.pathname} ${body.model}`)
      if (url.pathname.endsWith('/images/generations')) {
        if (body.model.startsWith('gemini') || body.model.includes('chat-only'))
          return Response.json(
            { error: { message: `Model ${body.model} is not supported on /v1/images/generations` } },
            { status: 400 },
          )
        return Response.json({ data: [{ b64_json: png }] })
      }
      if (body.model === 'text-only') return Response.json(reply({ content: '抱歉，我只会写字' }))
      return Response.json(reply({ content: `![](data:image/png;base64,${png})` }))
    },
  })
})
afterAll(() => server.stop(true))

test('聊天接口出图、自动模式猜错时换接口重试、没有图片时给出清楚的错误', async () => {
  const base = `http://127.0.0.1:${server.port}/v1`
  const run = (openaiModel: string, openaiApiType = 'auto') =>
    generateOpenAI(parseSettings({ openaiBaseUrl: base, openaiModel, openaiApiType }), 'a cat', 1024, 1024)
  hits.length = 0
  expect((await run('gemini-3.1-flash-image')).length).toBeGreaterThan(0)
  expect(hits).toEqual(['/v1/chat/completions gemini-3.1-flash-image'])
  // 手动指定图片接口时不自动换，直接报错
  await expect(run('gemini-3.1-flash-image', 'images')).rejects.toThrow('not supported')
  // 自动模式：模型名猜成图片接口，报「不支持」后自动换到聊天接口
  hits.length = 0
  expect((await run('relay-chat-only-painter', 'auto')).length).toBeGreaterThan(0)
  expect(hits).toEqual([
    '/v1/images/generations relay-chat-only-painter',
    '/v1/chat/completions relay-chat-only-painter',
  ])
  hits.length = 0
  expect((await run('gpt-image-2')).length).toBeGreaterThan(0)
  expect(hits).toEqual(['/v1/images/generations gpt-image-2'])
  await expect(run('text-only', 'chat')).rejects.toThrow('回复里没有图片')
})
