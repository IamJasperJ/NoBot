import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { supportsVision } from '@nobot/core'
import type { ChannelStickerDTO, ChannelStickerGroupDTO, ChannelStickerRef, ChannelStickersDTO } from '@nobot/shared'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, getSetting, newId } from '../../../db/client'
import { channelStickers as entries, channelStickerGroups as groups } from '../../../db/schema'
import { paths } from '../../../env'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { resolveApiPreset } from '../../../services/connections'
import { complete } from '../../../services/generation/quiet-prompt'
import { getLanguage } from '../../../services/settings'
import type { ExtensionHost } from '../../types'
import type { TelegramFetch } from './adapters/telegram/client'
import type { ChannelClient } from './adapters/types'
import { QQ_FACES } from './qq-faces'
import { resolveChannelSettings } from './settings'
import { accountRow } from './store'

export { telegramStickerSchema } from './sticker-types'

import { isQqMarketFace, isQqStickerSubtype, type TelegramSticker, telegramStickerSchema } from './sticker-types'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')

type StickerEntry = typeof entries.$inferSelect
type StickerLabeler = Pick<ExtensionHost, 'complete'>

// 平台通用占位不是情绪标签；统一去掉外层括号后也用于清理历史数据。
const genericSummaries = new Set([
  '动画表情',
  '表情',
  '图片',
  '表情包',
  '动态表情',
  '贴纸',
  'animated sticker',
  'animated emoji',
  'animated emoticon',
  'animation',
  'sticker',
  'emoji',
  'emoticon',
  'image',
  'picture',
  'photo',
])
const summaryMeaning = (value: string) =>
  value
    .trim()
    .replace(/^[[【]|[\]】]$/g, '')
    .trim()
const isGenericSummary = (value: string) => genericSummaries.has(summaryMeaning(value).toLowerCase())

function normalizeQqMeanings(entry: StickerEntry): StickerEntry {
  if (entry.ref.kind !== 'image' && entry.ref.kind !== 'mface') return entry
  const meanings = entry.meanings.filter((value) => !isGenericSummary(value))
  if (meanings.length === entry.meanings.length) return entry
  return db.update(entries).set({ meanings, labelAttempted: false }).where(eq(entries.id, entry.id)).returning().get()
}

/** 使用现有附件目录保存原始字节；saveAttachment 会转成静态 WebP，丢失表情动画。 */
export function cachedStickerFile(entry: StickerEntry) {
  if (!entry.cachedMime) return
  const file = join(paths.attachments, `${entry.id}.sticker`)
  return existsSync(file) ? Bun.file(file) : undefined
}

async function downloadSticker(url: string, fetcher: TelegramFetch, signal?: AbortSignal) {
  const response = await fetcher(url, {
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
    redirect: 'error',
  })
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  const reader = response.body?.getReader()
  if (!reader) return
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    if (
      !response.ok ||
      !mime?.startsWith('image/') ||
      Number(response.headers.get('content-length') ?? 0) > 5 * 1024 * 1024
    )
      return
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 5 * 1024 * 1024) return
      chunks.push(value)
    }
    if (size) return { bytes: Buffer.concat(chunks), mime }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

const caching = new Map<string, Promise<void>>()

/** QQ URL 带临时鉴权，几小时后会过期，因此收到时就缓存，不能等到预览或发送时再下载。 */
export async function cacheQqSticker(entry: StickerEntry, fetcher: TelegramFetch = fetch, signal?: AbortSignal) {
  const key = join(paths.attachments, entry.id)
  // 相同表情并发入站时串行检查；上一次失败后仍用数据库里的最新 URL 重试。
  const previous = caching.get(key)
  const task = (async () => {
    await previous
    const current = db.select().from(entries).where(eq(entries.id, entry.id)).get()
    if (
      !current ||
      cachedStickerFile(current) ||
      (current.ref.kind !== 'image' && current.ref.kind !== 'mface') ||
      !current.ref.url
    )
      return
    try {
      const image = await downloadSticker(current.ref.url, fetcher, signal)
      if (!image) return
      await Bun.write(join(paths.attachments, `${current.id}.sticker`), image.bytes)
      db.update(entries).set({ cachedMime: image.mime }).where(eq(entries.id, current.id)).run()
    } catch {
      /* 缓存失败仍保留引用，下次收到新鉴权地址时重试。 */
    }
  })()
  caching.set(key, task)
  try {
    await task
  } finally {
    if (caching.get(key) === task) caching.delete(key)
  }
}

export function platformUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href
  } catch {
    /* 无效引用不能变成本地路径。 */
  }
}
export function stickerGroup(accountId: string, source: ChannelStickerGroupDTO['source'], name: string, title: string) {
  const old = db
    .select()
    .from(groups)
    .where(and(eq(groups.accountId, accountId), eq(groups.source, source), eq(groups.name, name)))
    .get()
  if (old) return old
  return db.insert(groups).values({ id: newId(), accountId, source, name, title }).returning().get()
}
export function rememberSticker(
  accountId: string,
  groupId: string,
  platformKey: string,
  ref: ChannelStickerRef,
  meanings: string[],
) {
  const old = db
    .select()
    .from(entries)
    .where(and(eq(entries.accountId, accountId), eq(entries.platformKey, platformKey)))
    .get()
  // 刷新平台引用时保留主人设置和已缓存的标签。
  if (old) return db.update(entries).set({ ref, groupId }).where(eq(entries.id, old.id)).returning().get()
  return db.insert(entries).values({ id: newId(), accountId, groupId, platformKey, ref, meanings }).returning().get()
}
export function ensureQqFaces(accountId: string) {
  const group = stickerGroup(accountId, 'qq-face', 'builtin', t('QQ 内置表情'))
  // 只在初始化时种入，主人删除的条目不会在每次列表请求时重建。
  if (group.fetchedAt !== null) return
  db.transaction(() => {
    for (const face of QQ_FACES)
      rememberSticker(accountId, group.id, `face:${face.id}`, { kind: 'face', id: face.id }, [face.zh, face.en])
    db.update(groups).set({ fetchedAt: Date.now() }).where(eq(groups.id, group.id)).run()
  })
}
export function listStickers(accountId: string): ChannelStickersDTO {
  const account = accountRow(accountId)
  if (account.config.provider === 'onebot11') ensureQqFaces(accountId)
  const all = db.select().from(entries).where(eq(entries.accountId, accountId)).all().map(normalizeQqMeanings)
  const result = db
    .select()
    .from(groups)
    .where(eq(groups.accountId, accountId))
    .all()
    .map((group) => {
      const items: ChannelStickerDTO[] = all
        .filter((entry) => entry.groupId === group.id)
        .map((entry) => ({
          id: entry.id,
          groupId: group.id,
          accountId,
          ref: entry.ref,
          meanings: entry.meanings,
          enabled: entry.enabled,
          characters: entry.characters,
          usageCount: entry.usageCount,
          previewUrl: cachedStickerFile(entry)
            ? `/api/ext/channels/accounts/${encodeURIComponent(accountId)}/stickers/${encodeURIComponent(entry.id)}/preview`
            : entry.ref.kind === 'telegram'
              ? entry.ref.thumbnail
                ? `/api/ext/channels/accounts/${encodeURIComponent(accountId)}/stickers/${encodeURIComponent(entry.id)}/preview`
                : null
              : entry.ref.kind === 'face'
                ? null
                : (entry.ref.url ?? null),
        }))
      return {
        id: group.id,
        accountId,
        source: group.source,
        name: group.name,
        title: group.title,
        enabled: group.enabled,
        characters: group.characters,
        count: items.length,
        enabledCount: items.filter((entry) => group.enabled && entry.enabled).length,
        entries: items,
      }
    })
  return { groups: result, count: all.length }
}
export function usableStickers(accountId: string, speakerId?: string) {
  return listStickers(accountId)
    .groups.filter(
      (group) => group.enabled && (!group.characters.length || (!!speakerId && group.characters.includes(speakerId))),
    )
    .flatMap((group) =>
      group.entries
        .filter(
          (entry) =>
            entry.enabled &&
            entry.meanings.length &&
            (!entry.characters.length || (!!speakerId && entry.characters.includes(speakerId))) &&
            // TDLib 拒绝将 custom emoji 作为消息贴纸发送；仍保留引用供管理和预览。
            // https://github.com/tdlib/td/blob/master/td/telegram/MessageContent.cpp
            (entry.ref.kind !== 'telegram' || entry.ref.type !== 'custom_emoji'),
        )
        .map((entry) => ({ ...entry, characters: [...new Set([...group.characters, ...entry.characters])] })),
    )
}
export function parseStickerSetName(input: string) {
  const value = input.trim()
  const name = /^https?:\/\//i.test(value)
    ? /^https:\/\/t\.me\/addstickers\/([a-zA-Z0-9_]+)\/?(?:\?[^#]*)?$/.exec(value)?.[1]
    : value
  if (!name || !/^[a-zA-Z0-9_]{1,128}$/.test(name)) throw new HttpError(400, 'INVALID_INPUT', t('贴纸集名称或链接无效'))
  return name
}
function rememberTelegram(accountId: string, groupId: string, sticker: TelegramSticker, title: string) {
  const ref: ChannelStickerRef = {
    kind: 'telegram',
    file_id: sticker.file_id,
    file_unique_id: sticker.file_unique_id,
    emoji: sticker.emoji,
    set_name: sticker.set_name,
    type: sticker.type,
    format: sticker.is_video ? 'video' : sticker.is_animated ? 'animated' : 'static',
    thumbnail: sticker.thumbnail?.file_id,
  }
  const meanings = [sticker.emoji, title].filter((value): value is string => !!value)
  const entry = rememberSticker(accountId, groupId, `telegram:${sticker.file_unique_id}`, ref, meanings)
  // 单张先学习时可能只有 set_name；整集返回后补上真正标题。
  return db.update(entries).set({ meanings }).where(eq(entries.id, entry.id)).returning().get()
}
export async function importStickerSet(
  accountId: string,
  input: string,
  client: ChannelClient,
  auto = false,
  now = Date.now(),
) {
  if (accountRow(accountId).config.provider !== 'telegram') throw new HttpError(400, 'INVALID_INPUT', t('渠道设置无效'))
  const name = parseStickerSetName(input)
  const existing = db
    .select()
    .from(groups)
    .where(and(eq(groups.accountId, accountId), eq(groups.source, 'telegram-set')))
    .all()
  const old = existing.find((group) => group.name.toLowerCase() === name.toLowerCase())
  if (auto) {
    const settings = resolveChannelSettings(accountRow(accountId).config, undefined, getSetting('ext:channels')).values
    if (old?.fetchedAt !== null && old?.fetchedAt !== undefined) return
    if (!old && existing.length >= settings.stickerMaxSets) return
    // 每账号一分钟最多抓一个新集；失败的同集也等待一分钟再试，重启仍保留限速。
    if (existing.some((group) => group.attemptedAt !== null && now - group.attemptedAt < 60000)) return
  }
  const group = old ?? stickerGroup(accountId, 'telegram-set', name, name)
  db.update(groups).set({ attemptedAt: now }).where(eq(groups.id, group.id)).run()
  // https://core.telegram.org/bots/api#getstickerset：响应含标题、类型与全部平台 file_id。
  const set = z
    .object({ name: z.string(), title: z.string(), stickers: z.array(telegramStickerSchema) })
    .parse(await client.call('getStickerSet', { name }))
  db.transaction(() => {
    for (const sticker of set.stickers)
      rememberTelegram(accountId, group.id, { ...sticker, set_name: set.name }, set.title)
    db.update(groups).set({ title: set.title, fetchedAt: now }).where(eq(groups.id, group.id)).run()
  })
  return group.id
}
export async function learnTelegramSticker(accountId: string, sticker: TelegramSticker, client: ChannelClient) {
  const settings = resolveChannelSettings(accountRow(accountId).config, undefined, getSetting('ext:channels')).values
  let title = sticker.set_name ?? ''
  const known = sticker.set_name
    ? db
        .select()
        .from(groups)
        .where(eq(groups.accountId, accountId))
        .all()
        .find((group) => group.name === sticker.set_name)
    : undefined
  title = known?.title ?? title
  if (settings.stickerAutoLearn) {
    const group = known ?? stickerGroup(accountId, 'telegram-learned', 'learned', t('收到的贴纸'))
    rememberTelegram(accountId, group.id, sticker, title)
    if (sticker.set_name) {
      await importStickerSet(accountId, sticker.set_name, client, true).catch(() => {})
      title =
        db
          .select()
          .from(groups)
          .where(eq(groups.accountId, accountId))
          .all()
          .find((group) => group.name === sticker.set_name)?.title ?? title
    }
  }
  return `[sticker: ${sticker.emoji ?? ''}${title ? ` (${title})` : ''}]`
}
export async function labelCollectedFace(
  entry: typeof entries.$inferSelect,
  host: StickerLabeler,
  fetcher: TelegramFetch = fetch,
  signal?: AbortSignal,
) {
  entry = normalizeQqMeanings(db.select().from(entries).where(eq(entries.id, entry.id)).get() ?? entry)
  if (entry.labelAttempted || entry.meanings.length || (entry.ref.kind !== 'image' && entry.ref.kind !== 'mface'))
    return
  signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(60_000)])
  signal.throwIfAborted()
  const settings = resolveChannelSettings(
    accountRow(entry.accountId).config,
    undefined,
    getSetting('ext:channels'),
  ).values
  if (!settings.stickerAutoLabel) return
  let connection: ReturnType<typeof resolveApiPreset>
  try {
    connection = resolveApiPreset(null)
  } catch {
    return
  }
  if (!supportsVision(connection.model, connection.vision)) return
  // 原子占位确保学习与并发刷新也只标注一次，优先复用本地图片。
  const claimed = db
    .update(entries)
    .set({ labelAttempted: true })
    .where(and(eq(entries.id, entry.id), eq(entries.labelAttempted, false)))
    .returning()
    .get()
  if (!claimed) return
  try {
    const file = cachedStickerFile(entry)
    const bytes = file
      ? Buffer.from(await file.arrayBuffer())
      : entry.ref.url
        ? (await downloadSticker(entry.ref.url, fetcher, signal))?.bytes
        : undefined
    if (!bytes) return
    const label = await host.complete({
      connectionId: connection.id,
      messages: [
        {
          role: 'user',
          content: `Describe the emotion or meaning of this sticker using 1-3 short keywords, separated by commas. Return only keywords. Write in ${getLanguage() === 'en' ? 'English' : 'Chinese'}.`,
        },
      ],
      avatar: bytes,
      summary: t('表情含义标注'),
      maxTokens: 60,
      signal,
    })
    const meanings = label
      .split(/[,，、\n]/)
      .map((value) => value.trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 3)
    db.update(entries).set({ meanings }).where(eq(entries.id, entry.id)).run()
  } catch {
    /* 失败也记作已尝试，避免重复消耗模型额度。 */
  }
}
export async function refreshQqFaces(
  accountId: string,
  client: ChannelClient,
  host: ExtensionHost,
  fetcher?: TelegramFetch,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  if (accountRow(accountId).config.provider !== 'onebot11') throw new HttpError(400, 'INVALID_INPUT', t('渠道设置无效'))
  ensureQqFaces(accountId)
  // NapCat 返回 URL 数组，无独立 id；优先取 URL 内的 MD5，令临时查询参数变动不触发重复标注。
  // https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/extends/FetchCustomFace.ts
  const urls = z.array(z.string()).parse(await client.call('fetch_custom_face', { count: 1000 }, signal))
  const group = stickerGroup(accountId, 'qq-collected', 'collected', t('QQ 收藏表情'))
  for (const input of urls) {
    const url = platformUrl(input)
    if (!url) continue
    const id = qqStickerIdentity(url)
    const entry = rememberSticker(accountId, group.id, `collected:${id}`, { kind: 'image', id, url, sub_type: 1 }, [])
    await labelCollectedFace(entry, host, fetcher, signal)
  }
  // 收藏接口不包含普通入站学到的表情，也要让这些条目有机会补标注。
  for (const entry of db.select().from(entries).where(eq(entries.accountId, accountId)).all()) {
    await cachePending(entry)
    await labelCollectedFace(entry, host, fetcher, signal)
  }
  db.update(groups).set({ fetchedAt: Date.now() }).where(eq(groups.id, group.id)).run()
  return listStickers(accountId)
}
async function cachePending(entry: StickerEntry) {
  await caching.get(join(paths.attachments, entry.id))
}

export function learnQqSticker(
  accountId: string,
  segment: { type: string; data: Record<string, unknown> },
  options: { fetcher?: TelegramFetch; host?: StickerLabeler } = {},
) {
  const { data } = segment
  const settings = resolveChannelSettings(accountRow(accountId).config, undefined, getSetting('ext:channels')).values
  if (!settings.stickerAutoLearn) return
  const summary = typeof data.summary === 'string' ? data.summary.slice(0, 120) : ''
  let ref: ChannelStickerRef
  let key: string
  if (isQqMarketFace(segment)) {
    ref = {
      kind: 'mface',
      emoji_package_id: String(data.emoji_package_id),
      emoji_id: String(data.emoji_id),
      key: String(data.key),
      summary,
      url: platformUrl(data.url),
    }
    key = `mface:${ref.emoji_package_id}:${ref.emoji_id}`
  } else if (segment.type === 'image' && isQqStickerSubtype(data.sub_type)) {
    const url = platformUrl(data.url)
    if (!url) return
    const id = qqStickerIdentity(url, typeof data.file === 'string' ? data.file : undefined)
    ref = { kind: 'image', id, url, sub_type: Number(data.sub_type), summary }
    key = `image:${id}`
  } else return
  const group = stickerGroup(accountId, 'qq-learned', 'learned', t('收到的表情包'))
  const entry = normalizeQqMeanings(
    rememberSticker(
      accountId,
      group.id,
      key,
      ref,
      summary && !isGenericSummary(summary) ? [summaryMeaning(summary)] : [],
    ),
  )
  void cacheQqSticker(entry, options.fetcher)
    .then(() => labelCollectedFace(entry, options.host ?? { complete }, options.fetcher))
    .catch(() => {})
  return entry
}

/** QQ 临时鉴权参数不参与身份，保留 fileid 等真正区分资源的查询字段。 */
export function qqStickerIdentity(url: string, file?: string) {
  const md5 = /[a-f0-9]{32}/i.exec(file ?? '')?.[0] ?? /[a-f0-9]{32}/i.exec(url)?.[0]
  if (md5) return md5.toLowerCase()
  const parsed = new URL(url)
  for (const key of [...parsed.searchParams.keys()])
    if (/^(?:rkey|token|expires?|ts|sign(?:ature)?|time|auth)$/i.test(key)) parsed.searchParams.delete(key)
  parsed.searchParams.sort()
  parsed.hash = ''
  return hash(parsed.href)
}
/** 入站优先使用已缓存的标注，其次采用平台 summary；不为理解消息另起视觉请求。 */
export function qqStickerMeaning(accountId: string, segment: { type: string; data: Record<string, unknown> }) {
  const url = platformUrl(segment.data.url)
  const id = url
    ? qqStickerIdentity(url, typeof segment.data.file === 'string' ? segment.data.file : undefined)
    : undefined
  const known = db
    .select()
    .from(entries)
    .where(eq(entries.accountId, accountId))
    .all()
    .find((entry) =>
      entry.ref.kind === 'image'
        ? entry.ref.id === id
        : entry.ref.kind === 'mface' &&
          entry.ref.emoji_id === String(segment.data.emoji_id) &&
          entry.ref.emoji_package_id === String(segment.data.emoji_package_id),
    )
  const summary = String(segment.data.summary ?? '')
  return (
    known?.meanings.filter((value) => !isGenericSummary(value)).join(', ') ||
    (summary && !isGenericSummary(summary) ? summary : t('未标注表情包'))
  )
}
