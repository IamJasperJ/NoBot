import { createHash } from 'node:crypto'
import { guessVoiceGender } from '@nobot/core'
import type { FishVoiceItem, FishVoiceSearchResult, TtsOption } from '@nobot/shared'
import { z } from 'zod'
import { HttpError } from '../../../../errors'
import { t } from '../../../../i18n'
import type { AudioSettings } from './settings'

const strings = z
  .array(z.string().catch(''))
  .catch([])
  .transform((values) => values.filter(Boolean))
const itemSchema = z.object({
  _id: z.string().trim().min(1),
  title: z.string().catch(''),
  description: z.string().catch(''),
  author: z.object({ nickname: z.string().catch('') }).catch({ nickname: '' }),
  languages: strings,
  tags: strings,
  cover_image: z.string().min(1).nullable().catch(null),
  samples: z.array(z.object({ audio: z.string().min(1).nullable().catch(null) }).catch({ audio: null })).catch([]),
  liked: z.boolean().catch(false),
  marked: z.boolean().catch(false),
})
const pageSchema = z.object({
  items: z.array(z.unknown()).catch([]),
  total: z.number().int().nonnegative().catch(0),
  has_more: z.boolean().nullable().catch(null),
})
export interface FishSearchParams {
  query?: string
  language?: string
  self?: boolean
  page?: number
  pageSize?: number
}

export function fishApiRoot(endpoint: string): string {
  return endpoint.replace(/\/+$/, '').replace(/\/v1\/tts$/, '')
}

export function createFishClient(network: { fetch?: typeof fetch; mock?: boolean; now?: () => number } = {}) {
  const cache = new Map<string, { expires: number; items: FishVoiceItem[] }>()
  let cacheGeneration = 0
  const search = async (
    settings: AudioSettings,
    params: FishSearchParams,
    signal?: AbortSignal,
  ): Promise<FishVoiceSearchResult> => {
    const key = settings.fishApiKey.trim()
    if (!key) throw new HttpError(400, 'BAD_REQUEST', t('请先填写 Fish Audio 密钥'))
    if (network.mock ?? process.env.TTS_FETCH_MOCK === '1') return { items: [], total: 0, hasMore: false }
    try {
      const url = new URL(`${fishApiRoot(settings.fishEndpoint)}/model`)
      url.searchParams.set('page_size', String(params.pageSize ?? 20))
      url.searchParams.set('page_number', String(params.page ?? 1))
      if (params.query) url.searchParams.set('title', params.query)
      if (params.language) url.searchParams.set('language', params.language)
      if (params.self !== undefined) url.searchParams.set('self', String(params.self))
      const response = await (network.fetch ?? fetch)(url.toString(), {
        headers: { Authorization: `Bearer ${key}` },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      })
      if (!response.ok) throw new Error()
      const data = pageSchema.parse(await response.json())
      const items = data.items.flatMap((item): FishVoiceItem[] => {
        const parsed = itemSchema.safeParse(item)
        if (!parsed.success) return []
        const v = parsed.data
        return [
          {
            id: v._id,
            title: v.title || v._id,
            description: v.description,
            author: v.author.nickname,
            languages: v.languages,
            tags: v.tags,
            coverUrl: v.cover_image,
            sampleUrl: v.samples.find((sample) => sample.audio)?.audio ?? null,
            liked: v.liked,
            marked: v.marked,
          },
        ]
      })
      // 仅重排当前页；收藏和点赞都优先，并保留同一优先级的上游顺序。
      items.sort((a, b) => Number(b.marked || b.liked) - Number(a.marked || a.liked))
      // 官方允许 has_more 为 null；此时用总数判断，避免自己的声音只拉到第一页。
      const hasMore = data.has_more ?? (params.page ?? 1) * (params.pageSize ?? 20) < data.total
      return { items, total: data.total, hasMore }
    } catch {
      // 不携带上游正文、地址或原异常，防止第三方回显密钥。
      throw new HttpError(502, 'TTS_FAILED', t('语音服务请求失败，请检查配置'))
    }
  }
  const voices = async (settings: AudioSettings, signal?: AbortSignal) => {
    const merged = new Map<string, TtsOption>()
    for (const voice of settings.fishVoices) {
      if (voice.id && !merged.has(voice.id))
        merged.set(voice.id, {
          value: voice.id,
          label: voice.name || voice.id,
          gender: voice.gender ?? guessVoiceGender('fish', voice.id, voice.name),
        })
    }
    if (!settings.fishApiKey.trim() || (network.mock ?? process.env.TTS_FETCH_MOCK === '1')) return [...merged.values()]
    const cacheKey = JSON.stringify([
      createHash('sha256').update(settings.fishApiKey.trim()).digest('hex'),
      fishApiRoot(settings.fishEndpoint),
    ])
    const now = network.now ?? Date.now
    try {
      const cached = cache.get(cacheKey)
      let items = cached && cached.expires > now() ? cached.items : undefined
      if (!items) {
        // 清缓存时还在途的旧请求可以返回给原调用者，但不能重新填入缓存。
        const generation = cacheGeneration
        items = []
        for (let page = 1; page <= 5; page++) {
          const result = await search(settings, { self: true, page, pageSize: 100 }, signal)
          items.push(...result.items)
          if (!result.hasMore) break
        }
        if (generation === cacheGeneration) cache.set(cacheKey, { items, expires: now() + 5 * 60 * 1000 })
      }
      for (const voice of items) {
        if (!merged.has(voice.id))
          merged.set(voice.id, {
            value: voice.id,
            label: voice.title,
            gender: guessVoiceGender('fish', voice.id, voice.title),
          })
      }
    } catch {
      console.warn('Fish Audio 自己的声音拉取失败，使用手填声音')
    }
    return [...merged.values()]
  }
  return {
    search,
    voices,
    clearCache: () => {
      cacheGeneration++
      cache.clear()
    },
  }
}
export const fishClient = createFishClient()
