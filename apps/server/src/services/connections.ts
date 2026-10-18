import {
  type ApiPresetDTO,
  type ApiPresetInput,
  apiPresetInput,
  type TestConnectionInput,
  type TestConnectionResult,
} from '@ai-parter/shared'
import { asc, eq } from 'drizzle-orm'
import { db, getSetting, newId, setSetting } from '../db/client'
import { type ApiPresetRow, apiPresets } from '../db/schema'
import { HttpError, notFound } from '../errors'
import { t } from '../i18n'
import { listModels } from '../llm/openai'
import { SETTING_KEYS } from './settings'

// Zod 4 的 partial 仍会填充内部默认值，PATCH 必须显式移除 headers 默认值。
export const apiPresetPatchInput = apiPresetInput.partial().extend({
  headers: apiPresetInput.shape.headers.removeDefault().optional(),
  vision: apiPresetInput.shape.vision.removeDefault().optional(),
})

/** Key 打码：只露出最后 4 位 */
function maskKey(key: string) {
  if (!key) return ''
  return key.length <= 8 ? '••••' : `${key.slice(0, 3)}••••${key.slice(-4)}`
}

function toDTO(row: ApiPresetRow, defaultId: string | undefined): ApiPresetDTO {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    model: row.model,
    vision: row.vision,
    headers: row.headers,
    apiKeyMasked: maskKey(row.apiKey),
    isDefault: row.id === defaultId,
  }
}

export function listApiPresets(): ApiPresetDTO[] {
  const defaultId = getSetting<string>(SETTING_KEYS.defaultApiPresetId)
  return db
    .select()
    .from(apiPresets)
    .orderBy(asc(apiPresets.createdAt))
    .all()
    .map((r) => toDTO(r, defaultId))
}

export function getApiPresetRow(id: string): ApiPresetRow {
  const row = db.select().from(apiPresets).where(eq(apiPresets.id, id)).get()
  if (!row) throw notFound(t('连接配置'))
  return row
}

/** 会话没指定预设时用全局默认；默认也没有就报错，提示用户去配置 */
export function resolveApiPreset(presetId: string | null): ApiPresetRow {
  const id = presetId ?? getSetting<string>(SETTING_KEYS.defaultApiPresetId)
  if (!id) throw new HttpError(400, 'NO_API_PRESET', t('还没有配置模型连接，请先在「连接」页添加一个'))
  return getApiPresetRow(id)
}

export function createApiPreset(input: ApiPresetInput): ApiPresetDTO {
  const data = apiPresetInput.parse(input)
  const now = Date.now()
  const id = newId()
  db.insert(apiPresets)
    .values({ ...data, apiKey: data.apiKey ?? '', id, createdAt: now, updatedAt: now })
    .run()
  // 第一个预设自动设为默认
  if (!getSetting<string>(SETTING_KEYS.defaultApiPresetId)) setSetting(SETTING_KEYS.defaultApiPresetId, id)
  return toDTO(getApiPresetRow(id), getSetting<string>(SETTING_KEYS.defaultApiPresetId))
}

export function updateApiPreset(id: string, input: Partial<ApiPresetInput>): ApiPresetDTO {
  getApiPresetRow(id)
  const { apiKey, ...data } = apiPresetPatchInput.parse(input)
  db.update(apiPresets)
    .set({ ...data, ...(apiKey !== undefined ? { apiKey } : {}), updatedAt: Date.now() })
    .where(eq(apiPresets.id, id))
    .run()
  return toDTO(getApiPresetRow(id), getSetting<string>(SETTING_KEYS.defaultApiPresetId))
}

export function deleteApiPreset(id: string) {
  db.delete(apiPresets).where(eq(apiPresets.id, id)).run()
  if (getSetting<string>(SETTING_KEYS.defaultApiPresetId) === id) {
    setSetting(SETTING_KEYS.defaultApiPresetId, listApiPresets()[0]?.id ?? null)
  }
}

export function setDefaultApiPreset(id: string) {
  getApiPresetRow(id)
  setSetting(SETTING_KEYS.defaultApiPresetId, id)
}

/** 测试连接：可以测已保存的预设，也可以测表单里还没保存的地址和 Key */
export async function testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
  const saved = input.presetId ? getApiPresetRow(input.presetId) : null
  const baseUrl = input.baseUrl ?? saved?.baseUrl
  // 表单里 Key 留空表示沿用已保存的 Key
  const apiKey = input.apiKey || saved?.apiKey || ''
  if (!baseUrl) throw new HttpError(400, 'BAD_REQUEST', t('缺少接口地址'))
  try {
    return { ok: true, models: await listModels(baseUrl, apiKey, input.headers ?? saved?.headers ?? {}) }
  } catch (e) {
    return { ok: false, models: [], error: e instanceof Error ? e.message : String(e) }
  }
}
