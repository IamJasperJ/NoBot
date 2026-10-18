import { HttpError } from '../../../../errors'
import { t } from '../../../../i18n'
import { getApiPresetRow } from '../../../../services/connections'
import { openaiHeaders, openaiModels, openaiRequestHeaders } from '../discovery'
import { fitOpenaiSize } from '../options'
import type { Settings } from '../settings'
import { settingsSchema } from '../settings'
import { imageFetch, jsonResponse, object } from './http'
import { chatCapabilities, type ImageBackend, imageMime } from './types'

export function openaiBody(settings: Settings, prompt: string, width: number, height: number) {
  return {
    model: settings.openaiModel,
    prompt,
    n: 1,
    size: fitOpenaiSize(settings, width, height),
    // 质量选了就发（不再只对 gpt-image 发送），「自动」时不发，由接口自己决定
    ...(settings.openaiQuality !== 'auto' ? { quality: settings.openaiQuality } : {}),
    ...extraBody(settings),
  }
}

/**
 * 判断用哪个接口出图。
 * - images：/images/generations（gpt-image、dall-e 等）
 * - chat：/chat/completions，图片在回复里（Gemini 图片模型、nano-banana、Seedream 等常见中转都是这样提供的）
 * 自动模式按模型名猜；猜错时 generateOpenAI 还会根据报错自动换另一个接口重试一次
 */
export function openaiApiKind(settings: Settings): 'images' | 'chat' {
  if (settings.openaiApiType === 'images' || settings.openaiApiType === 'chat') return settings.openaiApiType
  return /gemini|flash-image|nano-?banana|seedream|seededit/i.test(settings.openaiModel) &&
    !/gpt-image|dall-e/i.test(settings.openaiModel)
    ? 'chat'
    : 'images'
}

/** 「额外参数」JSON，两个接口共用 */
function extraBody(settings: Settings): Record<string, unknown> {
  if (!settings.openaiExtra.trim()) return {}
  let extra: unknown
  try {
    extra = JSON.parse(settings.openaiExtra)
  } catch {
    throw new HttpError(400, 'IMAGE_EXTRA', t('额外参数不是合法的 JSON'))
  }
  if (!extra || typeof extra !== 'object' || Array.isArray(extra))
    throw new HttpError(400, 'IMAGE_EXTRA', t('额外参数必须是 JSON 对象'))
  return object(extra)
}

/** 最大公约数，用来把宽高化成「2:3」这样的比例 */
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
export function aspectRatio(width: number, height: number): string {
  const d = gcd(width, height) || 1
  return `${width / d}:${height / d}`
}

/** 聊天接口出图的请求体：提示词作为用户消息，声明要图片输出，并在提示词里注明画幅比例 */
export function openaiChatBody(settings: Settings, prompt: string, width: number, height: number) {
  return {
    model: settings.openaiModel,
    messages: [
      {
        role: 'user',
        content: `Generate an image. Do not reply with text.\nAspect ratio: ${aspectRatio(width, height)} (${width}x${height}).\nPrompt: ${prompt}`,
      },
    ],
    modalities: ['image', 'text'],
    stream: false,
    ...extraBody(settings),
  }
}

/**
 * 从聊天接口的回复里找出图片。不同中转返回的格式不一样，依次尝试：
 * - message.images[].image_url.url（OpenRouter 格式）
 * - content 是数组：{ type: 'image_url', image_url: { url } }、{ type: 'image', ... }、{ inline_data / inlineData: { data } }
 * - content 是字符串：Markdown 图片 ![](data:image/png;base64,...) 或 ![](https://...)，或裸的 data: / http 链接
 * 返回 data: 地址或 http 地址；找不到时返回 null
 */
export function findChatImage(body: Record<string, unknown>): string | null {
  const choice = object(Array.isArray(body.choices) ? body.choices[0] : undefined)
  const message = object(choice.message)
  const fromPart = (part: unknown): string | null => {
    const item = object(part)
    const imageUrl = item.image_url ?? item.imageUrl
    if (typeof imageUrl === 'string') return imageUrl
    if (typeof object(imageUrl).url === 'string') return object(imageUrl).url as string
    const inline = object(item.inline_data ?? item.inlineData ?? item.source)
    if (typeof inline.data === 'string') {
      const mime = String(inline.mime_type ?? inline.mimeType ?? inline.media_type ?? 'image/png')
      return `data:${mime};base64,${inline.data}`
    }
    if (typeof item.b64_json === 'string') return `data:image/png;base64,${item.b64_json}`
    if (typeof item.url === 'string' && /^(data:image|https?:)/.test(item.url)) return item.url
    return null
  }
  for (const image of Array.isArray(message.images) ? message.images : []) {
    const found = fromPart(image)
    if (found) return found
  }
  const content = message.content
  if (Array.isArray(content)) {
    for (const part of content) {
      const found = fromPart(part)
      if (found) return found
      // 有的中转把 Markdown 放在 text 部分里
      const text = object(part).text
      if (typeof text === 'string') {
        const inText = findImageInText(text)
        if (inText) return inText
      }
    }
  }
  if (typeof content === 'string') return findImageInText(content)
  return null
}

function findImageInText(text: string): string | null {
  const markdown = text.match(/!\[[^\]]*\]\(\s*(data:image\/[^)\s]+|https?:\/\/[^)\s]+)\s*\)/)
  if (markdown?.[1]) return markdown[1]
  const dataUrl = text.match(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/i)
  if (dataUrl) return dataUrl[0]
  const link = text.match(/https?:\/\/\S+\.(?:png|jpe?g|webp|gif)(?:\?\S*)?/i)
  return link ? link[0] : null
}

async function imageBytes(source: string, signal: AbortSignal): Promise<Uint8Array> {
  const data = source.match(/^data:image\/[^;]+;base64,(.+)$/)
  if (data?.[1]) return new Uint8Array(Buffer.from(data[1], 'base64'))
  return new Uint8Array(await (await imageFetch(source, { signal })).arrayBuffer())
}

async function viaImages(settings: Settings, prompt: string, width: number, height: number, signal: AbortSignal) {
  const response = await imageFetch(`${settings.openaiBaseUrl.replace(/\/+$/, '')}/images/generations`, {
    method: 'POST',
    signal,
    headers: openaiRequestHeaders(settings),
    body: JSON.stringify(openaiBody(settings, prompt, width, height)),
  })
  const body = await jsonResponse(response)
  const first = object(Array.isArray(body.data) ? body.data[0] : undefined)
  if (typeof first.b64_json === 'string' && first.b64_json) return new Uint8Array(Buffer.from(first.b64_json, 'base64'))
  if (typeof first.url === 'string') return imageBytes(first.url, signal)
  throw new HttpError(502, 'IMAGE_EMPTY', t('图片接口没有返回图片'))
}

async function viaChat(settings: Settings, prompt: string, width: number, height: number, signal: AbortSignal) {
  const response = await imageFetch(`${settings.openaiBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    signal,
    headers: openaiRequestHeaders(settings),
    body: JSON.stringify(openaiChatBody(settings, prompt, width, height)),
  })
  const body = await jsonResponse(response)
  const found = findChatImage(body)
  if (found) return imageBytes(found, signal)
  const message = object(object(Array.isArray(body.choices) ? body.choices[0] : undefined).message)
  const text = typeof message.content === 'string' ? message.content.slice(0, 120) : ''
  throw new HttpError(
    502,
    'IMAGE_EMPTY',
    t('聊天接口的回复里没有图片{reply}。请确认这个模型支持图片输出', {
      reply: text ? t('，模型回复：{text}', { text }) : '',
    }),
  )
}

/**
 * 自动模式下，第一个接口返回请求类错误（400、404、405、415、422）就换另一个接口再试一次——
 * 不再依赖报错文字里有没有「not supported」。鉴权（401、403）、限流（429）和服务器错误不换，直接报出来
 */
const wrongEndpoint = (error: unknown) =>
  error instanceof HttpError && /HTTP (400|404|405|415|422)\b/.test(error.message)

export async function generateOpenAI(
  settings: Settings,
  prompt: string,
  width: number,
  height: number,
  abort?: AbortSignal,
): Promise<Uint8Array> {
  const signal = AbortSignal.any([AbortSignal.timeout(300000), ...(abort ? [abort] : [])])
  const kind = openaiApiKind(settings)
  const first = kind === 'chat' ? viaChat : viaImages
  try {
    return await first(settings, prompt, width, height, signal)
  } catch (error) {
    if (settings.openaiApiType !== 'auto' || !wrongEndpoint(error) || signal.aborted) throw error
    const second = kind === 'chat' ? viaImages : viaChat
    return second(settings, prompt, width, height, signal)
  }
}

export const openaiBackend: ImageBackend = {
  id: 'openai',
  label: 'OpenAI 兼容接口',
  get settingsSchema() {
    return settingsSchema.filter((field) => field.key.startsWith('openai'))
  },
  capabilities: chatCapabilities,
  capabilitiesFor(settings) {
    if (!settings.openaiSnapSize || !/gpt-image-|dall-e-[23]/i.test(settings.openaiModel)) return chatCapabilities
    const values = new Set(
      [
        [512, 512],
        [1024, 1024],
        [1536, 1024],
        [1024, 1536],
      ].map(([width, height]) => fitOpenaiSize(settings, width!, height!)),
    )
    return {
      ...chatCapabilities,
      sizes: [...values].map((size) => {
        const [width, height] = size.split('x').map(Number)
        return { width: width!, height: height! }
      }),
    }
  },
  promptStyle: () => 'natural',
  model: (settings) => settings.openaiModel,
  resolveConnection(settings) {
    if (!settings.openaiConnectionId) return settings
    const connection = getApiPresetRow(settings.openaiConnectionId)
    const headers = new Headers(connection.headers)
    for (const [key, value] of Object.entries(openaiHeaders(settings))) headers.set(key, value)
    return {
      ...settings,
      openaiBaseUrl: connection.baseUrl,
      openaiApiKey: connection.apiKey,
      openaiHeaders: JSON.stringify(Object.fromEntries(headers)),
    }
  },
  validate(settings) {
    if (!settings.openaiBaseUrl.trim() || !settings.openaiModel.trim())
      throw new HttpError(400, 'IMAGE_CONFIG', t('请先配置图片接口地址和模型'))
  },
  dimensions(settings, width, height) {
    const [w, h] = fitOpenaiSize(settings, width, height).split('x').map(Number)
    return { width: w!, height: h! }
  },
  discover: async (settings) => ({ models: await openaiModels(settings) }),
  test: async (settings) => {
    await openaiModels(settings)
  },
  async generate({ settings, prompt, width, height }, signal) {
    const bytes = await generateOpenAI(settings, prompt, width, height, signal)
    return { bytes, mime: imageMime(bytes) }
  },
}
