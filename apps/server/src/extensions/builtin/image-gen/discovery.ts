import { getChatRow } from '../../../services/chats'
import { getApiPresetRow, resolveApiPreset } from '../../../services/connections'
import { imageFetch, jsonResponse, object } from './backends/http'
import { imageModelOptions, type Option } from './options'
import type { Settings } from './settings'

export function resolveImageConnection(settings: Settings): Settings {
  if (settings.source !== 'openai' || !settings.openaiConnectionId) return settings
  const connection = getApiPresetRow(settings.openaiConnectionId)
  const headers = new Headers(connection.headers)
  for (const [key, value] of Object.entries(openaiHeaders(settings))) headers.set(key, value)
  return {
    ...settings,
    openaiBaseUrl: connection.baseUrl,
    openaiApiKey: connection.apiKey,
    openaiHeaders: JSON.stringify(Object.fromEntries(headers)),
  }
}
/** 端点的全部模型都返回（不按名字筛选），看起来是图片模型的排在前面并标注 */
export async function openaiModels(settings: Settings) {
  const resolved = resolveImageConnection({ ...settings, source: 'openai' })
  const body = await jsonResponse(
    await imageFetch(`${resolved.openaiBaseUrl.replace(/\/+$/, '')}/models`, {
      headers: openaiRequestHeaders(resolved),
      signal: AbortSignal.timeout(30000),
    }),
  )
  const names = (Array.isArray(body.data) ? body.data : [])
    .map((item) => object(item).id)
    .filter((id): id is string => typeof id === 'string')
  return imageModelOptions(names)
}
export async function promptModels(settings: Settings, chatId?: string) {
  const connection = settings.promptConnectionId
    ? getApiPresetRow(settings.promptConnectionId)
    : resolveApiPreset(chatId ? getChatRow(chatId).apiPresetId : null)
  return openaiModels({
    ...settings,
    openaiConnectionId: '',
    openaiBaseUrl: connection.baseUrl,
    openaiApiKey: connection.apiKey,
    openaiHeaders: JSON.stringify(connection.headers),
  })
}
/** 解析「额外请求头」设置（JSON 对象，值必须是字符串） */
function parseHeaders(text: string, label: string): Record<string, string> {
  if (!text.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${label}额外请求头不是合法的 JSON`)
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((v) => typeof v !== 'string')
  )
    throw new Error(`${label}额外请求头必须是字符串值的 JSON 对象`)
  return parsed as Record<string, string>
}
export const comfyHeaders = (settings: Settings) => parseHeaders(settings.comfyHeaders, 'ComfyUI ')
export const openaiHeaders = (settings: Settings) => parseHeaders(settings.openaiHeaders, '图片接口')
/** 用 Headers 合并，保证大小写不同的 Authorization 也能覆盖默认鉴权。 */
export function openaiRequestHeaders(settings: Settings): Headers {
  const headers = new Headers({ 'Content-Type': 'application/json', Authorization: `Bearer ${settings.openaiApiKey}` })
  for (const [key, value] of Object.entries(openaiHeaders(settings))) headers.set(key, value)
  return headers
}
export interface Capabilities {
  models: Option[]
  samplers: Option[]
  schedulers: Option[]
  vaes: Option[]
}
const cache = new Map<string, { expires: number; headers: string; promise: Promise<Capabilities> }>()
export function comfyCapabilities(settings: Settings): Promise<Capabilities> {
  const url = settings.comfyUrl.replace(/\/+$/, '')
  const headers = comfyHeaders(settings)
  const previous = cache.get(url)
  const headerKey = JSON.stringify(headers)
  if (previous && previous.expires > Date.now() && previous.headers === headerKey) return previous.promise
  const promise = (async () => {
    const body = await jsonResponse(
      await imageFetch(`${url}/object_info`, { headers, signal: AbortSignal.timeout(30000) }),
    )
    const values = (node: string, key: string): string[] => {
      const field = object(object(object(body[node]).input).required)[key]
      return Array.isArray(field) && Array.isArray(field[0])
        ? field[0].filter((v): v is string => typeof v === 'string')
        : []
    }
    const options = (items: string[]) => items.map((value) => ({ value, label: value }))
    return {
      models: [
        ...values('CheckpointLoaderSimple', 'ckpt_name').map((value) => ({
          value,
          label: value.replace(/\.[^.]+$/, '').replaceAll('_', ' '),
        })),
        ...values('UNETLoader', 'unet_name').map((value) => ({ value, label: `UNet: ${value}` })),
        ...values('UnetLoaderGGUF', 'unet_name').map((value) => ({ value, label: `GGUF: ${value}` })),
      ],
      samplers: options(values('KSampler', 'sampler_name')),
      schedulers: options(values('KSampler', 'scheduler')),
      vaes: options(values('VAELoader', 'vae_name')),
    }
  })().catch((error) => {
    if (cache.get(url)?.promise === promise) cache.delete(url)
    throw new Error(`ComfyUI 能力发现失败：${error instanceof Error ? error.message : String(error)}`)
  })
  cache.set(url, { expires: Date.now() + 60000, headers: headerKey, promise })
  return promise
}
export async function testConnection(settings: Settings) {
  if (settings.source === 'openai') await openaiModels(settings)
  else
    await jsonResponse(
      await imageFetch(`${settings.comfyUrl.replace(/\/+$/, '')}/system_stats`, {
        headers: comfyHeaders(settings),
        signal: AbortSignal.timeout(30000),
      }),
    )
  return { ok: true, message: '连接成功' }
}
