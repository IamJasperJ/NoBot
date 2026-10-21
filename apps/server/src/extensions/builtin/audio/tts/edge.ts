import { t } from '../../../../i18n'
import { edgeTokenHash } from './edge-gec'

// 非官方接口；协议参照 edge-tts 7.3.1（https://github.com/rany2/edge-tts/tree/7.3.1）。
// 上游仍使用 2-143.0.3650.75，但 GEC 已改为 CS64-SHA256 v2，不能只更新版本号。
export const EDGE_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
export const EDGE_BASE = 'speech.platform.bing.com/consumer/speech/synthesize/readaloud'
export const EDGE_VERSION = '2-143.0.3650.75'
export const edgeHeaders = {
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
}
export function edgeGec(now: number) {
  // Windows 纪元比 Unix 早 11644473600 秒；五分钟窗口用整数运算避免百纳秒精度丢失。
  const seconds = BigInt(Math.floor(now / 1000)) + 11644473600n
  return edgeTokenHash(`${(seconds - (seconds % 300n)) * 10000000n}${EDGE_TOKEN}`)
}
export function xmlEscape(text: string) {
  return text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!,
  )
}
export type SocketFactory = (url: string, options: { headers: Record<string, string> }) => WebSocket
export class EdgeHandshakeError extends Error {
  constructor() {
    super(t('Edge 握手被拒绝，请检查网络或接口协议'))
  }
}
const defaultSocket: SocketFactory = (url, options) => new WebSocket(url, options)
export async function edgeSynthesize(
  input: { text: string; voice: string; speed: number; volume?: number; pitch?: number },
  signal?: AbortSignal,
  socket: SocketFactory = defaultSocket,
  request: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array; mime: string }> {
  try {
    return await edgeAttempt(input, Date.now(), signal, socket)
  } catch (error) {
    if (!(error instanceof EdgeHandshakeError)) throw error
    signal?.throwIfAborted()
    // Bun 的 WebSocket 错误不暴露握手响应头，改从同服务的 HTTPS 响应获取 Date 后仅重试一次。
    let serverTime: number
    try {
      const response = await request(`https://${EDGE_BASE}/voices/list?trustedclienttoken=${EDGE_TOKEN}`, {
        headers: edgeHeaders,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      })
      serverTime = Date.parse(response.headers.get('Date') ?? '')
      await response.body?.cancel()
    } catch {
      signal?.throwIfAborted()
      throw error
    }
    if (!Number.isFinite(serverTime)) throw error
    return edgeAttempt(input, serverTime, signal, socket)
  }
}
function edgeAttempt(
  input: { text: string; voice: string; speed: number; volume?: number; pitch?: number },
  now: number,
  signal: AbortSignal | undefined,
  socket: SocketFactory,
): Promise<{ bytes: Uint8Array; mime: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const params = new URLSearchParams({
      TrustedClientToken: EDGE_TOKEN,
      'Sec-MS-GEC': edgeGec(now),
      'Sec-MS-GEC-Version': EDGE_VERSION,
      ConnectionId: crypto.randomUUID().replaceAll('-', ''),
    })
    const ws = socket(`wss://${EDGE_BASE}/edge/v1?${params}`, {
      // 每次连接都生成新的大写 32 位十六进制 MUID，ConnectionId 和 X-RequestId 则使用无横线 UUID。
      headers: { ...edgeHeaders, Cookie: `muid=${crypto.randomUUID().replaceAll('-', '').toUpperCase()};` },
    })
    ws.binaryType = 'arraybuffer'
    const chunks: Uint8Array[] = []
    let settled = false
    let opened = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      ws.close()
      if (error) reject(error)
      else if (!chunks.length) reject(new Error(t('Edge 朗读失败，接口可能已变化')))
      else resolve({ bytes: Buffer.concat(chunks), mime: 'audio/mpeg' })
    }
    const fail = () => finish(opened ? new Error(t('Edge 朗读失败，接口可能已变化')) : new EdgeHandshakeError())
    const abort = () => finish(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    const timer = setTimeout(fail, 30000)
    signal?.addEventListener('abort', abort, { once: true })
    ws.onopen = () => {
      if (settled) return
      opened = true
      const timestamp = new Date().toUTCString()
      ws.send(
        `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } })}`,
      )
      const percent = Math.round((input.speed - 1) * 100)
      const rate = `${percent >= 0 ? '+' : ''}${percent}%`
      ws.send(
        `X-RequestId:${crypto.randomUUID().replaceAll('-', '')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp}Z\r\nPath:ssml\r\n\r\n<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${xmlEscape(input.voice)}"><prosody pitch="${(input.pitch ?? 0) >= 0 ? '+' : ''}${input.pitch ?? 0}%" rate="${rate}" volume="${(input.volume ?? 0) >= 0 ? '+' : ''}${input.volume ?? 0}%">${xmlEscape(input.text)}</prosody></voice></speak>`,
      )
    }
    ws.onmessage = (event) => {
      if (settled) return
      if (typeof event.data === 'string') {
        if (/Path:turn.end\r?\n/i.test(event.data)) finish()
        return
      }
      // 二进制帧前两字节是大端头部长度；头部后才是 MP3，不能把元数据帧混进音频。
      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength < 2) {
        fail()
        return
      }
      const data = new Uint8Array(event.data)
      const length = new DataView(event.data).getUint16(0)
      if (length + 2 > data.length) {
        fail()
        return
      }
      if (/Path:audio\r?\n/i.test(new TextDecoder().decode(data.subarray(2, length + 2))))
        chunks.push(data.slice(length + 2))
    }
    ws.onerror = fail
    ws.onclose = () => {
      if (!settled) fail()
    }
  })
}
