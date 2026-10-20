import { getLanguage } from '../i18n'
import { setSessionAnonymous } from '../stores/session'

/** 保留原始响应及流，只在同源 API 会话失效时通知 store；登录失败不影响现有会话。 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const origin = globalThis.location?.origin ?? 'http://localhost'
  const url = new URL(raw, origin)
  const api = url.origin === origin && url.pathname.startsWith('/api/')
  let response: Response
  if (api) {
    // 未登录时服务端读不到用户的语言设置，按 Accept-Language 翻译错误信息：带上界面当前的语言
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (!headers.has('Accept-Language')) headers.set('Accept-Language', getLanguage() === 'en' ? 'en' : 'zh-CN')
    response = await fetch(input, { ...init, headers })
  } else response = await (init === undefined ? fetch(input) : fetch(input, init))
  if (response.status === 401 && api && !['/api/auth/me', '/api/auth/login'].includes(url.pathname))
    setSessionAnonymous()
  return response
}
