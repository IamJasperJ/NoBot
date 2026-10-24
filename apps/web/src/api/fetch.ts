import { getLanguage } from '../i18n'
import { setSessionAnonymous } from '../stores/session'
import { scopedApiPath, scopeForChat, scopeRoomData } from './room-scope'

/** 保留原始响应及流，只在同源 API 会话失效时通知 store；登录失败不影响现有会话。 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (typeof input === 'string' && input.startsWith('/api/')) {
    raw = scopedApiPath(input)
    if (input === '/api/attachments' && init?.body instanceof FormData) {
      const chatId = init.body.get('chatId')
      const roomId = typeof chatId === 'string' ? scopeForChat(chatId) : undefined
      if (roomId) raw = `/api/rooms/${encodeURIComponent(roomId)}/scope/attachments`
    }
    if (input === '/api/ext/audio/tts/message' && typeof init?.body === 'string') {
      try {
        const body: unknown = JSON.parse(init.body)
        if (body && typeof body === 'object' && 'messageId' in body && typeof body.messageId === 'string') {
          const messagePath = scopedApiPath(`/api/messages/${body.messageId}`)
          const prefix = /^(\/api\/rooms\/[^/]+\/scope)\//.exec(messagePath)?.[1]
          if (prefix) raw = `${prefix}/ext/audio/tts/message`
        }
      } catch {
        /* 服务端负责验证请求格式。 */
      }
    }
    if (input === '/api/ext/audio/tts/line' && typeof init?.body === 'string') {
      try {
        const body: unknown = JSON.parse(init.body)
        const roomId =
          body && typeof body === 'object' && 'chatId' in body && typeof body.chatId === 'string'
            ? scopeForChat(body.chatId)
            : undefined
        if (roomId) raw = `/api/rooms/${encodeURIComponent(roomId)}/scope/ext/audio/tts/line`
      } catch {
        /* 服务端继续负责验证无效 JSON。 */
      }
    }
    input = raw
  }
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
  const room = /^\/api\/rooms\/([^/]+)\/scope\//.exec(url.pathname)
  const chat = /^\/api\/chats\/([^/]+)$/.exec(url.pathname)
  const roomId = room?.[1] ?? (chat ? scopeForChat(chat[1]!) : undefined)
  if (response.ok && roomId && response.headers.get('Content-Type')?.includes('application/json')) {
    const data: unknown = await response.json()
    return new Response(JSON.stringify(scopeRoomData(data, decodeURIComponent(roomId))), {
      status: response.status,
      headers: response.headers,
    })
  }
  return response
}
