import { HttpError } from '../../../../errors'
import { t } from '../../../../i18n'

export async function imageFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    const response = await fetch(url, init)
    if (!response.ok)
      throw new HttpError(
        502,
        'IMAGE_HTTP',
        t('图片接口 HTTP {status}：{error}', { status: response.status, error: (await response.text()).slice(0, 200) }),
      )
    return response
  } catch (error) {
    if (error instanceof HttpError) throw error
    if (init.signal?.aborted) throw new HttpError(502, 'IMAGE_TIMEOUT', t('图片接口请求超时'))
    throw new HttpError(
      502,
      'IMAGE_NETWORK',
      t('图片接口请求失败：{error}', { error: error instanceof Error ? error.message : String(error) }),
    )
  }
}
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
export async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  try {
    return object(await response.json())
  } catch {
    throw new HttpError(502, 'IMAGE_JSON', t('图片接口返回的不是合法的 JSON'))
  }
}
