import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentContext } from '../../../../../user-context'
import { TelegramClient, TelegramError } from './client'
import { decodeTelegram, verifyWebhookSecret } from './receive'
import { inlineTelegramSegments, renderTelegram } from './render'
import { DeferredTelegramStream, TelegramTextStream } from './stream'

let testDirectory: string
let previousDirectory: string | undefined
beforeAll(() => {
  previousDirectory = process.env.DATA_DIR
  testDirectory = mkdtempSync(join(tmpdir(), 'nobot-telegram-unit-'))
  process.env.DATA_DIR = testDirectory
})
afterAll(() => {
  currentContext().sqlite.close()
  if (previousDirectory === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = previousDirectory
  rmSync(testDirectory, { recursive: true, force: true })
})

const bot = { id: '99', username: 'mybot' }
const message = (extra = {}) => ({
  update_id: 1,
  message: {
    message_id: 2,
    chat: { id: 3, type: 'private' },
    from: { id: 4, first_name: 'Alice' },
    text: 'hello',
    ...extra,
  },
})
describe('Telegram 解码与验签', () => {
  test('私聊、群话题、命令目标、提及和编辑', () => {
    expect(decodeTelegram(message(), bot)).toMatchObject({ type: 'message', text: 'hello', displayName: 'Alice' })
    const group = message({ chat: { id: -3, type: 'supergroup' }, message_thread_id: 7, text: '/roll@mybot d20' })
    expect(decodeTelegram(group, bot)).toMatchObject({ message_thread_id: 7, command: { name: 'roll', args: 'd20' } })
    expect(decodeTelegram(message({ text: '/help@other' }), bot)).toBeNull()
    expect(
      decodeTelegram(message({ text: 'hi @mybot', entities: [{ type: 'mention', offset: 3, length: 6 }] }), bot),
    ).toMatchObject({ mentionsBot: true })
    const edited = message()
    expect(decodeTelegram({ update_id: 2, edited_message: edited.message }, bot)).toMatchObject({ type: 'edit' })
  })
  test('回调、成员变更、媒体和自己的 bot 回声', () => {
    expect(
      decodeTelegram(
        {
          update_id: 1,
          callback_query: { id: 'callback', from: { id: 1 }, data: 'token', message: message().message },
        },
        bot,
      ),
    ).toMatchObject({ type: 'callback', data: 'token' })
    expect(
      decodeTelegram(
        {
          update_id: 2,
          my_chat_member: {
            chat: { id: -1, type: 'group' },
            from: { id: 1 },
            old_chat_member: { status: 'left' },
            new_chat_member: { status: 'member' },
          },
        },
        bot,
      ),
    ).toMatchObject({ type: 'membership' })
    expect(decodeTelegram(message({ photo: [{}], text: undefined }), bot)).toMatchObject({ unsupportedMedia: true })
    expect(decodeTelegram(message({ from: { id: 99, first_name: 'Bot', is_bot: true } }), bot)).toBeNull()
    expect(decodeTelegram({ update_id: 'invalid' }, bot)).toBeNull()
  })
  test('不接受缺失、错误或空 secret', () => {
    expect(verifyWebhookSecret('good', 'good')).toBe(true)
    expect(verifyWebhookSecret(undefined, 'good')).toBe(false)
    expect(verifyWebhookSecret('evil', 'good')).toBe(false)
    expect(verifyWebhookSecret('', '')).toBe(false)
  })
})
describe('Telegram HTML', () => {
  test('转义与标签独立闭合', () => {
    expect(
      renderTelegram([
        { kind: 'speaker', text: '<Alice>&"' },
        { kind: 'narration', text: '走进房间' },
      ]),
    ).toEqual(['<b>&lt;Alice&gt;&amp;&quot;</b><i>走进房间</i>'])
  })
  test('4096 UTF-16、中文、emoji、长段落不丢字符', () => {
    const raw = `${'中文😀'.repeat(4097)}\n\n${'a & <b>'.repeat(1000)}`
    const pages = renderTelegram([{ kind: 'narration', text: raw }])
    const decode = (html: string) =>
      html
        .replace(/<\/?i>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
    expect(pages.map(decode).join('')).toBe(raw)
    for (const page of pages) {
      const text = decode(page)
      expect(text.length).toBeLessThanOrEqual(4096)
      expect(text).not.toMatch(/[\uD800-\uDBFF]$/)
      expect(text).not.toMatch(/^[\uDC00-\uDFFF]/)
      expect(page.startsWith('<i>')).toBe(true)
      expect(page.endsWith('</i>')).toBe(true)
    }
  })
})
function fakeClient(respond?: (method: string, body: Record<string, unknown>) => Response) {
  const calls: { method: string; body: Record<string, unknown> }[] = []
  const waits: number[] = []
  const client = new TelegramClient({
    token: 'TOP_SECRET',
    baseUrl: 'https://example.test',
    now: () => 0,
    sleep: async (ms) => {
      waits.push(ms)
    },
    fetch: async (url, init) => {
      expect(String(url)).toStartWith('https://example.test/botTOP_SECRET/')
      const method = String(url).split('/').at(-1)!,
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
      calls.push({ method, body })
      return respond?.(method, body) ?? Response.json({ ok: true, result: { message_id: 1 } })
    },
  })
  return { client, calls, waits }
}
describe('Telegram 传输', () => {
  test('429 retry_after、有界重试与错误脱敏', async () => {
    let attempt = 0
    const { client, waits } = fakeClient(() =>
      ++attempt === 1
        ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: 2 }, description: 'TOP_SECRET' })
        : Response.json({ ok: true, result: true }),
    )
    expect(await client.call('sendMessage')).toBe(true)
    expect(waits).toContain(2000)
    const failure = fakeClient(() =>
      Response.json({ ok: false, error_code: 403, description: 'TOP_SECRET https://example.test/botTOP_SECRET' }),
    )
    try {
      await failure.client.call('sendMessage')
      throw new Error('expected failure')
    } catch (error) {
      expect(error).toBeInstanceOf(TelegramError)
      expect(String(error)).not.toContain('TOP_SECRET')
    }
  })
  test('游标仅在处理成功后保存，失败退避并重放', async () => {
    const controller = new AbortController()
    let attempts = 0
    const saved: number[] = []
    const { client, calls, waits } = fakeClient(() => Response.json({ ok: true, result: [{ update_id: 7 }] }))
    await client.poll({
      cursor: 6,
      signal: controller.signal,
      handle: async () => {
        if (++attempts === 1) throw new Error('transient')
      },
      persist: (cursor) => {
        saved.push(cursor)
        controller.abort()
      },
    })
    expect(attempts).toBe(2)
    expect(saved).toEqual([7])
    expect(calls[0]?.body.offset).toBe(7)
    expect(waits).toContain(500)
  })
  test('私聊草稿必须在定稿时发送持久消息', async () => {
    const { client, calls } = fakeClient()
    const stream = new TelegramTextStream(client, { chat: '1', private: true }, { draftId: 1, intervalMs: 1 })
    stream.update('draft')
    await new Promise((resolve) => setTimeout(resolve, 10))
    await stream.commit('final')
    expect(calls.map((c) => c.method)).toContain('sendMessageDraft')
    expect(calls.filter((c) => c.method === 'sendMessage').at(-1)?.body.text).toBe('final')
  })
  test('草稿不支持时记住降级，群流式合并更新并跳过相同文本', async () => {
    const { client, calls } = fakeClient((method) =>
      method === 'sendMessageDraft'
        ? Response.json({ ok: false, error_code: 400 })
        : Response.json({ ok: true, result: { message_id: 10 } }),
    )
    const stream = new TelegramTextStream(client, { chat: '1', private: true }, { draftId: 1, intervalMs: 1 })
    stream.update('one')
    stream.update('two')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(client.draftSupported).toBe(false)
    stream.update('two')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1)
    await stream.commit('three')
    expect(calls.filter((c) => c.method === 'editMessageText')).toHaveLength(1)
  })
  test('群定稿编辑失败时引用旧消息发送新版本', async () => {
    const { client, calls } = fakeClient((method) =>
      method === 'editMessageText'
        ? Response.json({ ok: false, error_code: 400 })
        : Response.json({ ok: true, result: { message_id: 77 } }),
    )
    const stream = new TelegramTextStream(client, { chat: '-1', private: false }, { draftId: 1, messageId: 12 })
    expect(await stream.commit('replacement')).toEqual([77])
    expect(calls.find((c) => c.method === 'sendMessage')?.body.reply_parameters).toEqual({
      message_id: 12,
      allow_sending_without_reply: true,
    })
  })
  test('身份查验期间缓存增量，初始化前中止不会投递正文', async () => {
    const { client, calls } = fakeClient()
    let release!: (stream: TelegramTextStream) => void
    const opening = new Promise<TelegramTextStream>((resolve) => {
      release = resolve
    })
    const stream = new DeferredTelegramStream(() => opening)
    stream.update('first')
    stream.update('latest')
    const final = stream.commit('final')
    release(new TelegramTextStream(client, { chat: '-1', private: false }, { draftId: 1, accountId: 'speaker' }))
    expect(await final).toEqual([1])
    expect(stream.accountId).toBe('speaker')
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1)
    const stopped = new DeferredTelegramStream(
      async () => new TelegramTextStream(client, { chat: '-2', private: false }, { draftId: 2 }),
    )
    stopped.abort()
    expect(await stopped.commit('never send')).toEqual([])
    expect(calls.some((c) => c.body.text === 'never send')).toBe(false)
  })
})

test('普通回复不变成旁白，仅动作星号斜体，强调加粗且转义 HTML', () => {
  expect(renderTelegram(inlineTelegramSegments('Hello <world>'))).toEqual(['Hello &lt;world&gt;'])
  expect(renderTelegram(inlineTelegramSegments('Hello *waves* **friend**'))).toEqual([
    'Hello <i>waves</i> <b>friend</b>',
  ])
})
test('首条私聊草稿立即发送，后续更新按间隔合并，定稿仍发送持久消息', async () => {
  const { client, calls } = fakeClient()
  const stream = new TelegramTextStream(client, { chat: '1', private: true }, { draftId: 2, intervalMs: 250 })
  try {
    stream.update('first')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls.filter((c) => c.method === 'sendMessageDraft').map((c) => c.body.text)).toEqual(['first'])
    stream.update('second')
    stream.update('third')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls.filter((c) => c.method === 'sendMessageDraft')).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(calls.filter((c) => c.method === 'sendMessageDraft').map((c) => c.body.text)).toEqual(['first', 'third'])
    await stream.commit('final')
    expect(calls.filter((c) => c.method === 'sendMessage').at(-1)?.body.text).toBe('final')
  } finally {
    stream.abort()
  }
})
