import { parseCardJson } from '@ai-parter/core'
import { HttpError } from '../errors'
import { t } from '../i18n'
import { readZip } from './zip'

/** 只解析内嵌资源；外部 URI 不触发网络请求。 */
export function readCharx(bytes: Uint8Array) {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) return null
  const entries = readZip(bytes)
  const json = entries.find((entry) => entry.path === 'card.json')
  if (!json) throw new HttpError(400, 'BAD_CARD', t('CharX 缺少 card.json'))
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(json.data))
  } catch {
    throw new HttpError(400, 'BAD_CARD', t('CharX 的 card.json 不是合法 JSON'))
  }
  const card = parseCardJson(raw)
  const data = card.raw.data
  const assets = data && typeof data === 'object' && 'assets' in data && Array.isArray(data.assets) ? data.assets : []
  const resources: { type: string; name: string; data: Uint8Array }[] = []
  for (const asset of assets) {
    if (
      !asset ||
      typeof asset !== 'object' ||
      typeof asset.uri !== 'string' ||
      typeof asset.type !== 'string' ||
      typeof asset.name !== 'string'
    )
      continue
    const path = /^(?:embeded|embedded):\/\/(.+)$/.exec(asset.uri)?.[1]
    if (!path) continue
    const entry = entries.find((entry) => entry.path === path)
    if (entry) resources.push({ type: asset.type, name: asset.name, data: entry.data })
  }
  const icons = resources.filter((asset) => asset.type === 'icon')
  return {
    card,
    avatar: (icons.find((icon) => icon.name === 'main') ?? icons[0])?.data,
    emotions: resources.filter((asset) => asset.type === 'emotion'),
  }
}
