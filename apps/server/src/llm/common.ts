import { t } from '../i18n'
import { LlmError } from './types'
export function endpoint(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

export function headers(apiKey: string, extra: Record<string, string> = {}): Headers {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) h.Authorization = `Bearer ${apiKey}`
  const merged = new Headers(h)
  for (const [key, value] of Object.entries(extra)) merged.set(key, value)
  return merged
}

/** 把上游的 HTTP 错误翻译成看得懂的提示 */
export async function toLlmError(res: Response): Promise<LlmError> {
  let detail = ''
  try {
    const text = await res.text()
    try {
      const json = JSON.parse(text)
      detail = json?.error?.message ?? json?.message ?? text
    } catch {
      detail = text
    }
  } catch {
    // 读不出响应体就算了
  }
  detail = String(detail).slice(0, 500)

  const hint: Record<number, string> = {
    400: t('请求被拒绝，可能是参数或模型不支持'),
    401: t('API Key 无效或已过期'),
    403: t('没有权限访问这个模型'),
    404: t('接口地址或模型名不存在'),
    429: t('请求太频繁或额度用完了'),
  }
  const base = hint[res.status] ?? (res.status >= 500 ? t('模型服务暂时不可用') : t('请求失败'))
  return new LlmError(
    `HTTP_${res.status}`,
    detail
      ? t('{base}（{status}）：{detail}', { base, status: res.status, detail })
      : t('{base}（{status}）', { base, status: res.status }),
  )
}

/** fetch 本身失败（断网、域名错误、被中止） */
export function toNetworkError(e: unknown, url: string): Error {
  if (e instanceof DOMException && e.name === 'AbortError') return e
  const host = (() => {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  })()
  return new LlmError(
    'NETWORK',
    t('无法连接到 {host}：{error}', { host, error: e instanceof Error ? e.message : String(e) }),
  )
}

/** 统一检查 HTTP、连接错误及空响应，避免各协议漏掉代理错误。 */
export async function request(url: string, init: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch (error) {
    throw toNetworkError(error, url)
  }
  if (!res.ok) throw await toLlmError(res)
  if (!res.body) throw new LlmError('EMPTY', t('模型接口没有返回内容'))
  return res
}

/** 外部 JSON 仅在协议边界使用宽类型，业务层始终返回统一类型。 */
export type Json = Record<string, any>

export function upstreamError(json: Json) {
  if (json.error)
    throw new LlmError(
      'UPSTREAM',
      t('模型返回错误：{error}', {
        error: String(json.error.message ?? JSON.stringify(json.error)).slice(0, 500),
      }),
    )
}
