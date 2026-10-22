import { HttpError } from '../../../../../errors'
import { t } from '../../../../../i18n'

export const failed = () => new HttpError(502, 'TTS_FAILED', t('语音服务请求失败，请检查配置'))

export function createEngineHttp(network: { fetch?: typeof fetch }, offline: () => boolean, mockAudio: Uint8Array) {
  const request = async (url: string, init: RequestInit = {}, timeout = 30000) => {
    const signal = init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout)
    try {
      const result = await (network.fetch ?? fetch)(url, { ...init, signal })
      if (!result.ok) throw new Error()
      return result
    } catch {
      // 不透传上游响应或 URL，避免第三方把密钥回显在错误里。
      throw failed()
    }
  }
  const synth = async (
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
    mime = 'audio/mpeg',
  ) => {
    signal?.throwIfAborted()
    if (offline()) return { bytes: mockAudio, mime: 'audio/wav' }
    const response = await post(url, body, headers, signal)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (!bytes.length) throw new HttpError(502, 'TTS_FAILED', t('语音服务返回了空音频'))
    return { bytes, mime }
  }
  const post = (url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal) =>
    request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    })
  return { request, synth, post, offline }
}

export type EngineHttp = ReturnType<typeof createEngineHttp>
