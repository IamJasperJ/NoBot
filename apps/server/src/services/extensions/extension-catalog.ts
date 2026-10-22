import { type ExtensionCatalogDTO, extensionPermissionsSchema } from '@nobot/shared'
import { z } from 'zod'
import { getSetting, setSetting } from '../../db/client'
import { HttpError } from '../../errors'
import { listExtensions } from '../../extensions/registry'
import { t } from '../../i18n'
import { currentUser } from '../../user-context'
import { validateGitUrl } from './extension-git'

const itemSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().default(''),
  author: z.string().default(''),
  repo: z.string().min(1),
  ref: z.string().optional(),
  version: z.string().optional(),
  tags: z.array(z.string()).default([]),
  permissions: extensionPermissionsSchema.optional(),
})

const caches = new Map<string, { key: string; expires: number; value: ExtensionCatalogDTO }>()

export function catalogSources() {
  return { urls: getSetting<string[]>('extensionCatalogs') ?? [] }
}

export function setCatalogSources(urls: string[]) {
  if (urls.some((url) => !['https:', 'http:'].includes(new URL(url).protocol)))
    throw new HttpError(400, 'INVALID_CATALOG_URL', t('目录索引地址只允许 HTTP 或 HTTPS'))
  setSetting('extensionCatalogs', [...new Set(urls)])
  caches.delete(currentUser().handle)
  return catalogSources()
}

async function readSource(url: string): Promise<ExtensionCatalogDTO['sources'][number]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(t('目录索引请求失败：HTTP {status}', { status: response.status }))
    const limit = 2 * 1024 * 1024
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel()
      throw new Error(t('目录索引超过 2MB 限制'))
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error(t('目录索引内容为空'))
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > limit) throw new Error(t('目录索引超过 2MB 限制'))
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new Error(t('目录索引不是合法的 JSON'))
    }
    const items = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && 'extensions' in raw
        ? raw.extensions
        : null
    if (!Array.isArray(items)) throw new Error(t('目录索引必须是数组或包含 extensions 数组的对象'))
    return {
      url,
      ok: true,
      items: items.flatMap((item) => {
        const parsed = itemSchema.safeParse(item)
        if (!parsed.success) return []
        try {
          validateGitUrl(parsed.data.repo)
        } catch {
          return []
        }
        return [{ ...parsed.data, installed: false }]
      }),
    }
  } catch (error) {
    return { url, ok: false, error: t('目录索引加载失败：{error}', { error: String(error) }), items: [] }
  } finally {
    clearTimeout(timer)
  }
}

export async function extensionCatalog(refresh = false): Promise<ExtensionCatalogDTO> {
  const { urls } = catalogSources()
  const handle = currentUser().handle
  let cache = caches.get(handle)
  const key = JSON.stringify(urls)
  if (refresh || !cache || cache.key !== key || cache.expires <= Date.now()) {
    const sources = []
    for (const url of urls) sources.push(await readSource(url))
    cache = { key, expires: Date.now() + 5 * 60 * 1000, value: { sources } }
    caches.set(handle, cache)
  }
  // 安装状态不放进缓存，安装、更新与卸载后无需再次下载目录索引。
  const installed = new Map(
    listExtensions()
      .filter((entry) => !entry.loadError)
      .map((entry) => [entry.id, entry]),
  )
  return {
    sources: cache.value.sources.map((source) => ({
      ...source,
      items: source.items.map((item) => ({
        ...item,
        installed: installed.has(item.id),
        ...(installed.has(item.id) ? { installedVersion: installed.get(item.id)!.version } : {}),
      })),
    })),
  }
}
