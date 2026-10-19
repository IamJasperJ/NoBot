import { providerInfo, providerOptions } from '@nobot/shared'
import { t } from '../i18n'
import { endpoint, type Json, request, toNetworkError, upstreamError } from './common'
import { anthropicCompletion, anthropicHeaders } from './providers/anthropic'
import { azureCompletion } from './providers/azure'
import { googleCompletion } from './providers/google'
import { openaiBase, openaiCompletion, openaiHeaders } from './providers/openai'
import { vertexConfig } from './providers/vertex'
import { type CompletionRequest, type LlmConnection, LlmError, type StreamChunk } from './types'

export { buildRequestBody } from './body'
export * from './types'

/** 结构类型同时接受数据库行与测试连接草稿，统一合并目录默认值。 */
export function toLlmConnection(row: {
  provider?: string
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
  options?: Record<string, string>
}): LlmConnection {
  const provider = row.provider ?? 'custom'
  return {
    provider,
    baseUrl: row.baseUrl || providerInfo(provider).baseUrls[0]?.url || '',
    apiKey: row.apiKey ?? '',
    headers: row.headers ?? {},
    options: providerOptions(provider, row.options),
  }
}

export async function* chatCompletion(req: CompletionRequest): AsyncGenerator<StreamChunk> {
  const c = toLlmConnection(req.connection)
  req = { ...req, connection: c }
  try {
    switch (providerInfo(c.provider).protocol) {
      case 'anthropic':
        yield* anthropicCompletion(req)
        break
      case 'google': {
        const url = `${c.baseUrl.replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(String(req.body.model).replace(/^models\//, ''))}:${req.body.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`
        yield* googleCompletion(
          req,
          url,
          new Headers({ 'Content-Type': 'application/json', 'x-goog-api-key': c.apiKey, ...c.headers }),
        )
        break
      }
      case 'vertex': {
        const config = await vertexConfig(c, req.signal)
        yield* googleCompletion(
          req,
          `${config.base}/${encodeURIComponent(String(req.body.model))}:${req.body.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
          config.headers,
        )
        break
      }
      case 'azure':
        yield* azureCompletion(req)
        break
      default:
        yield* openaiCompletion(req)
    }
  } catch (error) {
    if (error instanceof LlmError || req.signal.aborted || (error instanceof Error && error.name === 'AbortError'))
      throw error
    throw toNetworkError(error, c.baseUrl)
  }
}

/** 静态目录不产生网络请求；测试连接时另发最小生成请求验证凭证。 */
export async function listModels(connection: LlmConnection): Promise<string[]> {
  const c = toLlmConnection(connection)
  const info = providerInfo(c.provider)
  if (info.models === 'static') return [...(info.staticModels ?? [])]
  const signal = AbortSignal.timeout(15_000)
  try {
    let url = endpoint(openaiBase(c), '/models')
    let headers = openaiHeaders(c)
    if (info.protocol === 'anthropic') headers = anthropicHeaders(c.apiKey, c.headers)
    if (info.protocol === 'google') {
      url = endpoint(c.baseUrl, '/v1beta/models')
      headers = new Headers({ 'x-goog-api-key': c.apiKey, ...c.headers })
    }
    if (info.protocol === 'vertex') {
      const config = await vertexConfig(c, signal)
      // Model Garden 的列表接口不挂在项目路径下，且使用 beta 版本。
      url = config.base.replace(/\/v1\/.*$/, '/v1beta1/publishers/google/models')
      headers = config.headers
    }
    const models: string[] = []
    const pages = new Set<string>()
    let page: string | undefined
    do {
      const next = new URL(url)
      if (page) next.searchParams.set(info.protocol === 'anthropic' ? 'after_id' : 'pageToken', page)
      const res = await request(next.toString(), { headers, signal })
      const json = (await res.json()) as Json
      upstreamError(json)
      const list: Json[] = json.models ?? json.publisherModels ?? json.data ?? (Array.isArray(json) ? json : [])
      for (const model of list) {
        if (info.protocol === 'google' && !model.supportedGenerationMethods?.includes('generateContent')) continue
        const id = typeof model === 'string' ? model : (model.id ?? model.name)
        if (typeof id === 'string')
          models.push(
            info.protocol === 'google' || info.protocol === 'vertex'
              ? id.replace(/^(?:publishers\/google\/)?models\//, '')
              : id,
          )
      }
      const token = info.protocol === 'anthropic' && json.has_more ? json.last_id : json.nextPageToken
      if (token && (typeof token !== 'string' || pages.has(token)))
        throw new LlmError('UPSTREAM', t('模型列表分页游标重复'))
      if (token) pages.add(token)
      page = token
    } while (page)
    return [...new Set(models)].sort()
  } catch (error) {
    if (error instanceof LlmError || (error instanceof Error && error.name === 'AbortError')) throw error
    throw toNetworkError(error, c.baseUrl)
  }
}
