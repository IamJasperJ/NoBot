import type { ChannelAccountConfig, ChannelFriendDTO } from '@nobot/shared'
import type { TelegramFetch } from '../telegram/client'
import type { ChannelClient } from '../types'
import { OneBotStatus } from './status'
import { OneBotError, OneBotSendQueue, type OneBotTransport } from './transport'

export interface OneBotSegment {
  type: string
  data: Record<string, unknown>
}
export const plainText = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
/** 按段落优先拆分，按 Unicode 字符计数，不能切断代理对。 */
export function splitOneBot(text: string, limit = 4500) {
  const pages: string[] = []
  let rest = Array.from(text)
  while (rest.length > limit) {
    const chunk = rest.slice(0, limit).join('')
    const paragraph = chunk.lastIndexOf('\n\n')
    const take = paragraph > chunk.length / 2 ? Array.from(chunk.slice(0, paragraph + 2)).length : limit
    pages.push(rest.slice(0, take).join(''))
    rest = rest.slice(take)
  }
  if (rest.length) pages.push(rest.join(''))
  return pages
}
export class OneBotClient implements ChannelClient {
  draftSupported = false
  onDraftUnsupported?: () => void
  selfId = ''
  nickname = ''
  implementation = { name: '', version: '' }
  private readonly lifetime = new AbortController()
  private queue: OneBotSendQueue
  private queues = new Map<string, Promise<unknown>>()
  private media = new Map<string, { kind: 'image' | 'record'; file: string; url?: string }>()
  private friends?: { at: number; rows: ChannelFriendDTO[] }
  private status = new OneBotStatus((status) =>
    this.action('set_online_status', { status, ext_status: 0, battery_status: 0 }),
  )
  private cards = new Map<string, string>()
  constructor(
    readonly transport: OneBotTransport,
    readonly config: ChannelAccountConfig,
    private fetcher: TelegramFetch = fetch,
    private signal?: AbortSignal,
    queue?: OneBotSendQueue,
  ) {
    this.signal = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    this.queue = queue ?? new OneBotSendQueue(config.rateLimit)
    this.signal.addEventListener(
      'abort',
      () => {
        this.status.clear()
        transport.stop()
      },
      { once: true },
    )
  }
  stop() {
    this.lifetime.abort()
    this.transport.stop()
  }
  get napcat() {
    return /napcat/i.test(this.implementation.name)
  }
  async connected() {
    const bot = await this.action<{ user_id: number; nickname: string }>('get_login_info')
    this.selfId = String(bot.user_id)
    this.nickname = bot.nickname
    const version = await this.action<{ app_name?: string; app_version?: string }>('get_version_info')
    this.implementation = { name: version.app_name ?? '', version: version.app_version ?? '' }
  }
  action<T = boolean>(action: string, params: Record<string, unknown> = {}, signal = this.signal) {
    return this.transport.call<T>(action, params, signal)
  }
  async friendList(refresh = false) {
    if (!refresh && this.friends && Date.now() - this.friends.at < 60000) return this.friends.rows
    const rows = await this.action<ChannelFriendDTO[]>('get_friend_list')
    this.friends = { at: Date.now(), rows }
    return rows
  }
  invalidateFriends() {
    this.friends = undefined
  }
  async privateAllowed(user: string, group?: string, temporary = this.config.settings.tempSessionDm) {
    if ((await this.friendList()).some((friend) => String(friend.user_id) === user)) return true
    return !!(this.napcat && temporary && group)
  }
  registerMedia(kind: 'image' | 'record', file: string, url?: string) {
    const key = `${kind}:${file}`
    this.media.set(key, { kind, file, url })
    if (this.media.size > 1000) this.media.delete(this.media.keys().next().value!)
    return key
  }
  async downloadFile(key: string, limit: number) {
    const media = this.media.get(key)
    if (!media) throw new OneBotError(-1)
    // NapCat 本地路径属于远端，禁止据此读取 NoBot 的磁盘。get_record 可直接返回转换后的 base64。
    // https://napneko.github.io/develop/file
    let info: { url?: string; file?: string; base64?: string } = {}
    if (media.kind === 'record' || !media.url)
      info = await this.action(media.kind === 'record' ? 'get_record' : 'get_image', {
        file: media.file,
        ...(media.kind === 'record' ? { out_format: 'mp3' } : {}),
      })
    if (info.base64) {
      const bytes = new Uint8Array(Buffer.from(info.base64, 'base64'))
      if (bytes.length > limit) throw new OneBotError(413)
      return bytes
    }
    const url = info.url ?? info.file ?? media.url
    if (!url || !/^https?:\/\//.test(url)) throw new OneBotError(-1)
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(30000), redirect: 'error' })
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > limit) throw new OneBotError(413)
    const reader = response.body?.getReader()
    if (!reader) throw new OneBotError(-1)
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > limit) throw new OneBotError(413)
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    return new Uint8Array(Buffer.concat(chunks))
  }
  async fileDataHint(path: string) {
    return `data:image/jpeg;base64,${Buffer.from(await this.downloadFile(path, 20 * 1024 * 1024)).toString('base64')}`
  }
  serialized<T>(chat: string, fn: () => Promise<T>) {
    const pending = (this.queues.get(chat) ?? Promise.resolve()).catch(() => {}).then(fn)
    this.queues.set(chat, pending)
    void pending
      .finally(() => {
        if (this.queues.get(chat) === pending) this.queues.delete(chat)
      })
      .catch(() => {})
    return pending
  }
  async send(chat: string, message: OneBotSegment[], scope: 'private' | 'group', extra: Record<string, unknown> = {}) {
    return this.queue.send(
      chat,
      () =>
        this.action<{ message_id: number }>(scope === 'group' ? 'send_group_msg' : 'send_private_msg', {
          [scope === 'group' ? 'group_id' : 'user_id']: Number(chat),
          message,
          ...extra,
        }),
      this.signal,
    )
  }
  groupCard(group: string, name: string) {
    // 审批和首条群消息可能同时同步名片；串行后再比较，只缓存已成功应用的值。
    return this.serialized(`card:${group}`, async () => {
      if (this.cards.get(group) === name) return
      await this.action('set_group_card', { group_id: Number(group), user_id: Number(this.selfId), card: name })
      this.cards.set(group, name)
    })
  }
  onlineStatus(status: 10 | 30 | 50) {
    if (this.napcat) this.status.follow(status)
  }
  async prepareStop(follow: boolean) {
    if (follow && this.napcat && !this.transport.paused) await this.status.leaving(this.signal)
  }
  async forward(group: string, nodes: { name: string; text: string }[]) {
    if (!this.napcat) throw new OneBotError(-1)
    return this.queue.send(
      group,
      () =>
        this.action<{ message_id: number }>('send_group_forward_msg', {
          group_id: Number(group),
          messages: nodes.map((node) => ({
            type: 'node',
            data: { nickname: node.name, uin: this.selfId, content: [{ type: 'text', data: { text: node.text } }] },
          })),
        }),
      this.signal,
    )
  }
  /** 旧服务使用语义近似的 Telegram 操作名；这里统一翻译，线上的报文始终为 OneBot 动作和消息段。 */
  async call<T = boolean>(
    method: string,
    input: Record<string, unknown> | FormData = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const params: Record<string, unknown> = input instanceof FormData ? Object.fromEntries(input.entries()) : input
    let result: unknown
    const chat = String(params.chat_id ?? '')
    const group = chat.startsWith('-')
    const id = group ? chat.slice(1) : chat
    if (method === 'getMe') result = { id: Number(this.selfId), first_name: this.nickname, is_bot: true }
    else if (method === 'getChat') {
      const info = await this.action<{ group_name?: string; nickname?: string }>(
        group ? 'get_group_info' : 'get_stranger_info',
        { [group ? 'group_id' : 'user_id']: Number(id) },
        signal,
      )
      result = { title: info.group_name, first_name: info.nickname }
    } else if (method === 'getChatMember') {
      const info = await this.action<{ role: string }>(
        'get_group_member_info',
        { group_id: Number(id), user_id: Number(params.user_id), no_cache: true },
        signal,
      )
      result = { status: info.role === 'owner' ? 'creator' : info.role === 'admin' ? 'administrator' : 'member' }
    } else if (method === 'leaveChat')
      result = await this.action('set_group_leave', { group_id: Number(id), is_dismiss: false }, signal)
    else if (method === 'deleteMessage')
      result = await this.action('delete_msg', { message_id: params.message_id }, signal)
    else if (method === 'getFile') result = { file_path: params.file_id }
    else if (method === 'sendChatAction' || method === 'editMessageReplyMarkup') result = true
    else if (method.startsWith('editMessage')) throw new OneBotError(-1)
    else if (method === 'sendMessage' || ['sendPhoto', 'sendDocument', 'sendVoice', 'sendAudio'].includes(method)) {
      const segments: OneBotSegment[] = []
      if (params.reply_parameters && group)
        segments.push({
          type: 'reply',
          data: { id: String((params.reply_parameters as { message_id: number }).message_id) },
        })
      let text = String(params.text ?? params.caption ?? '')
      if (params.parse_mode === 'HTML') text = plainText(text)
      if (method !== 'sendMessage') {
        const kind = method === 'sendVoice' || method === 'sendAudio' ? 'record' : 'image'
        const field = { sendPhoto: 'photo', sendDocument: 'document', sendVoice: 'voice', sendAudio: 'audio' }[method]!
        const asset = params[field]
        const file =
          asset instanceof Blob
            ? `base64://${Buffer.from(await asset.arrayBuffer()).toString('base64')}`
            : String(asset)
        segments.push({ type: kind, data: { file } })
      }
      const markup = params.reply_markup as
        | { inline_keyboard?: { text: string; callback_data?: string; url?: string }[][] }
        | undefined
      const choices = markup?.inline_keyboard
        ?.flat()
        .filter((item) => !['⟲', '◀', '▶', '➕', '🗑', '🔊', '📖'].includes(item.text))
      if (choices?.length)
        text += `\n${choices.map((item, index) => `${index + 1}. ${item.text}${item.url ? ` ${item.url}` : ''}`).join('\n')}`
      for (const page of splitOneBot(text, this.config.settings.maxMessageLength)) {
        result = await this.send(id, [...segments, { type: 'text', data: { text: page } }], group ? 'group' : 'private')
        segments.length = 0
      }
      if (!text) result = await this.send(id, segments, group ? 'group' : 'private')
    } else throw new OneBotError(-1)
    return result as T
  }
}
