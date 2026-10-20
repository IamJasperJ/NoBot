import { t } from '../../i18n'
import { currentUser } from '../../user-context'
import { type Json, request } from '../common'
import { type LlmConnection, LlmError } from '../types'

const tokens = new Map<string, { token: string; expires: number; key: string }>()
const oauthUrl = 'https://oauth2.googleapis.com/token'
const encode = (value: string | Uint8Array) => Buffer.from(value).toString('base64url')

/** 缓存按账号隔离，并检查私钥，避免轮换凭证后继续使用旧 token。 */
async function accessToken(account: Json, signal: AbortSignal, extra: Record<string, string>): Promise<string> {
  const cacheKey = `${currentUser().handle}:${account.client_email}`
  const cached = tokens.get(cacheKey)
  if (cached && cached.key === account.private_key && cached.expires > Date.now() + 60_000) return cached.token
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${encode(
    JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: oauthUrl,
      iat: now,
      exp: now + 3600,
    }),
  )}`
  const key = await crypto.subtle.importKey(
    'pkcs8',
    Buffer.from(account.private_key.replace(/-----[^-]+-----|\s/g, ''), 'base64'),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const res = await request(oauthUrl, {
    method: 'POST',
    signal,
    headers: { ...extra, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${encode(new Uint8Array(signature))}`,
    }),
  })
  const json = (await res.json()) as Json
  if (typeof json.access_token !== 'string') throw new LlmError('AUTH', t('Vertex 服务账号鉴权失败'))
  tokens.set(cacheKey, {
    token: json.access_token,
    key: account.private_key,
    expires: Date.now() + Number(json.expires_in ?? 3600) * 1000,
  })
  return json.access_token
}

export async function vertexConfig(c: LlmConnection, signal: AbortSignal): Promise<{ base: string; headers: Headers }> {
  const region = c.options.region || 'global'
  const origin = new URL(c.baseUrl)
  // 官方域名随区域选择，代理地址则保留，便于自部署网关。
  const base = origin.hostname.endsWith('aiplatform.googleapis.com')
    ? `https://${region === 'global' ? '' : `${region}-`}aiplatform.googleapis.com`
    : c.baseUrl.replace(/\/+$/, '')
  const headers = new Headers({ 'Content-Type': 'application/json', ...c.headers })
  let project = c.options.projectId
  if (c.options.authMode === 'service_account') {
    let account: Json
    try {
      account = JSON.parse(c.apiKey)
      if (!account || typeof account.client_email !== 'string' || typeof account.private_key !== 'string')
        throw new Error()
    } catch {
      throw new LlmError('AUTH', t('Vertex 服务账号 JSON 无效'))
    }
    project ||= account.project_id
    if (!project) throw new LlmError('AUTH', t('Vertex 服务账号缺少项目 ID'))
    headers.set('Authorization', `Bearer ${await accessToken(account, signal, c.headers)}`)
  } else headers.set('x-goog-api-key', c.apiKey)
  return {
    base: `${base}/v1/${project ? `projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/` : ''}publishers/google/models`,
    headers,
  }
}
