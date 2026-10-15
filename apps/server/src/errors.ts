import type { ContentfulStatusCode } from 'hono/utils/http-status'

/**
 * 业务错误。在 service 里直接 throw，由 app.onError 统一转成
 * { error: { code, message } } 返回给前端。message 是给用户看的中文提示。
 */
export class HttpError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export const notFound = (what: string) => new HttpError(404, 'NOT_FOUND', `${what}不存在`)
