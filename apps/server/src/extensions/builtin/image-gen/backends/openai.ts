import { HttpError } from '../../../../errors'
import { openaiRequestHeaders } from '../discovery'
import { openaiSize } from '../options'
import type { Settings } from '../settings'
import { imageFetch, jsonResponse, object } from './http'

export function openaiBody(settings: Settings, prompt: string, width: number, height: number) {
  let extra: unknown = {}
  if (settings.openaiExtra.trim()) {
    try {
      extra = JSON.parse(settings.openaiExtra)
    } catch {
      throw new HttpError(400, 'IMAGE_EXTRA', '额外参数不是合法的 JSON')
    }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra))
      throw new HttpError(400, 'IMAGE_EXTRA', '额外参数必须是 JSON 对象')
  }
  return {
    model: settings.openaiModel,
    prompt,
    n: 1,
    size: openaiSize(settings.openaiModel, width, height),
    ...(/gpt-image-/i.test(settings.openaiModel) ? { quality: settings.openaiQuality } : {}),
    ...object(extra),
  }
}
export async function generateOpenAI(
  settings: Settings,
  prompt: string,
  width: number,
  height: number,
  abort?: AbortSignal,
): Promise<Uint8Array> {
  const signal = AbortSignal.any([AbortSignal.timeout(300000), ...(abort ? [abort] : [])])
  const response = await imageFetch(`${settings.openaiBaseUrl.replace(/\/+$/, '')}/images/generations`, {
    method: 'POST',
    signal,
    headers: openaiRequestHeaders(settings),
    body: JSON.stringify(openaiBody(settings, prompt, width, height)),
  })
  const body = await jsonResponse(response)
  const first = object(Array.isArray(body.data) ? body.data[0] : undefined)
  if (typeof first.b64_json === 'string' && first.b64_json) return new Uint8Array(Buffer.from(first.b64_json, 'base64'))
  if (typeof first.url === 'string')
    return new Uint8Array(await (await imageFetch(first.url, { signal })).arrayBuffer())
  throw new HttpError(502, 'IMAGE_EMPTY', '图片接口没有返回图片')
}
