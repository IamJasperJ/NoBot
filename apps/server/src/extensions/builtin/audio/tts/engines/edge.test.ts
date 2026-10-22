import { expect, test } from 'bun:test'
import { audioSettings } from '../settings'
import {
  EDGE_VERSION,
  EdgeHandshakeError,
  edgeGec,
  edgeHeaders,
  edgeSynthesize,
  type SocketFactory,
} from './edge/client'
import { createTtsEngines } from './index'

// 参考值由 Python edge-tts 7.3.1 的 generate_sec_ms_gec_v2 计算，包含窗口边界和当前纪元。
test.each([
  [0, '52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6'],
  [299999, '52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6'],
  [300000, 'F7535A20A262E331-28675BF85C7106BBF20035A78FCB0B6890813EAD5C3B983EF3424931B720BABB'],
  [1792454400000, 'DDC36A108314D354-FD5177A2FD5614537896EBF6F496FAE64677549620256DDB1F3556D9440C82A8'],
])('GEC v2 与上游参考值一致：%s', (now, expected) => {
  expect(edgeGec(now as number)).toBe(expected)
})

function fakeSocket() {
  return {
    close() {},
    send() {},
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  } as unknown as WebSocket
}
function audioReply(ws: WebSocket) {
  ws.onopen?.(new Event('open'))
  const header = Buffer.from('Path:audio\r\n')
  const frame = Buffer.alloc(2 + header.length + 3)
  frame.writeUInt16BE(header.length)
  header.copy(frame, 2)
  frame.set([1, 2, 3], 2 + header.length)
  ws.onmessage?.(
    new MessageEvent('message', { data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.length) }),
  )
  ws.onmessage?.(new MessageEvent('message', { data: 'Path:turn.end\r\n\r\n' }))
}
const input = { text: '你好', voice: 'zh-CN-XiaoxiaoNeural', speed: 1 }

test('握手失败后按服务端 Date 校正 GEC 并重试一次，重新生成连接标识和 Cookie', async () => {
  const calls: { url: URL; headers: Record<string, string> }[] = []
  const sockets: WebSocket[] = []
  const socket: SocketFactory = (url, options) => {
    calls.push({ url: new URL(url), headers: options.headers })
    const ws = fakeSocket()
    sockets.push(ws)
    queueMicrotask(() => {
      if (calls.length === 1) ws.onerror?.(new Event('error'))
      else audioReply(ws)
    })
    return ws
  }
  let requests = 0
  const request = Object.assign(
    async () => {
      requests++
      return new Response('', { headers: { Date: 'Thu, 01 Jan 1970 00:05:00 GMT' } })
    },
    { preconnect: fetch.preconnect },
  ) as typeof fetch
  expect((await edgeSynthesize(input, undefined, socket, request)).bytes).toEqual(new Uint8Array([1, 2, 3]))
  expect(requests).toBe(1)
  expect(sockets).toHaveLength(2)
  expect(calls[1]!.url.searchParams.get('Sec-MS-GEC')).toBe(edgeGec(300000))
  expect(calls[1]!.url.searchParams.get('Sec-MS-GEC-Version')).toBe(EDGE_VERSION)
  expect(calls[0]!.url.searchParams.get('ConnectionId')).toMatch(/^[a-f0-9]{32}$/)
  expect(calls[0]!.url.searchParams.get('ConnectionId')).not.toBe(calls[1]!.url.searchParams.get('ConnectionId'))
  expect(calls[0]!.headers.Cookie).toMatch(/^muid=[A-F0-9]{32};$/)
  expect(calls[0]!.headers.Cookie).not.toBe(calls[1]!.headers.Cookie)
  expect(calls[0]!.headers).toMatchObject(edgeHeaders)
})

test('重复握手被拒绝时保留独立错误，不无限重试', async () => {
  let attempts = 0
  const socket: SocketFactory = () => {
    attempts++
    const ws = fakeSocket()
    queueMicrotask(() => ws.onclose?.(new CloseEvent('close', { code: 1002 })))
    return ws
  }
  const request = Object.assign(async () => new Response('', { headers: { Date: new Date().toUTCString() } }), {
    preconnect: fetch.preconnect,
  }) as typeof fetch
  await expect(edgeSynthesize(input, undefined, socket, request)).rejects.toBeInstanceOf(EdgeHandshakeError)
  expect(attempts).toBe(2)
})

test('打开连接后的合成失败不走握手重试', async () => {
  const ws = fakeSocket()
  const result = edgeSynthesize(input, undefined, () => ws)
  ws.onopen?.(new Event('open'))
  ws.onerror?.(new Event('error'))
  await expect(result).rejects.toThrow('Edge 朗读失败，接口可能已变化')
})

test('Edge 演绎写入 SSML，合并默认音量和用户语速', async () => {
  const sent: string[] = []
  const engines = createTtsEngines({
    mock: false,
    socket: () => {
      const ws = fakeSocket()
      ws.send = (text) => {
        sent.push(String(text))
      }
      queueMicrotask(() => audioReply(ws))
      return ws
    },
    fetch: (() => {
      throw new Error('不应联网')
    }) as unknown as typeof fetch,
  })
  await engines.edge.synthesize(
    {
      ...input,
      speed: 1.5,
      delivery: { tone: 'sad', intensity: 2, volume: 'whisper', direction: '' },
    },
    audioSettings.parse({ edgeVolume: 50 }),
  )
  const ssml = sent.find((text) => text.includes('Path:ssml'))!
  expect(ssml).toContain('rate="+38%"')
  expect(ssml).toMatch(/pitch="-4(?:\.0+\d*)?%"/)
  expect(ssml).toMatch(/volume="-10(?:\.0+\d*)?%"/)
  expect(ssml).not.toContain('express-as')
})
