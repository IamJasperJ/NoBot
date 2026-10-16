import { exportSTPreset, importSTPreset, STFormatError } from '@ai-parter/core'
import { type PromptPresetDTO, type PromptPresetInput, presetDataSchema, promptPresetInput } from '@ai-parter/shared'
import { asc, eq } from 'drizzle-orm'
import { db, getSetting, newId, setSetting } from '../db/client'
import { promptPresets } from '../db/schema'
import { HttpError, notFound } from '../errors'
import { SETTING_KEYS } from './settings'

export function listPromptPresets(): PromptPresetDTO[] {
  return db
    .select()
    .from(promptPresets)
    .orderBy(asc(promptPresets.createdAt), asc(promptPresets.id))
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      data: presetDataSchema.parse(row.data),
      updatedAt: row.updatedAt,
      isDefault: row.id === getSetting<string>(SETTING_KEYS.defaultPromptPresetId),
    }))
}
export function getPromptPreset(id: string): PromptPresetDTO {
  const preset = listPromptPresets().find((row) => row.id === id)
  if (!preset) throw notFound('生成预设')
  return preset
}
export function createPromptPreset(input: PromptPresetInput): PromptPresetDTO {
  const data = promptPresetInput.parse(input)
  const id = newId()
  const now = Date.now()
  db.transaction(() => {
    db.insert(promptPresets)
      .values({ ...data, id, createdAt: now, updatedAt: now })
      .run()
    if (!getSetting(SETTING_KEYS.defaultPromptPresetId)) setSetting(SETTING_KEYS.defaultPromptPresetId, id)
  })
  return getPromptPreset(id)
}
export function updatePromptPreset(id: string, input: Partial<PromptPresetInput>): PromptPresetDTO {
  getPromptPreset(id)
  const data = promptPresetInput.partial().parse(input)
  // Zod 4 的 partial 仍可能填默认值；PATCH 只保留客户端实际传入的字段。
  for (const key of Object.keys(data) as (keyof typeof data)[]) {
    if (!Object.hasOwn(input, key)) delete data[key]
  }
  db.update(promptPresets)
    .set({ ...data, updatedAt: Date.now() })
    .where(eq(promptPresets.id, id))
    .run()
  return getPromptPreset(id)
}
export function deletePromptPreset(id: string) {
  db.transaction(() => {
    const preset = getPromptPreset(id)
    const remaining = listPromptPresets().filter((row) => row.id !== id)
    if (!remaining.length) throw new HttpError(400, 'LAST_PRESET', '不能删除最后一个生成预设')
    db.delete(promptPresets).where(eq(promptPresets.id, id)).run()
    if (preset.isDefault) setSetting(SETTING_KEYS.defaultPromptPresetId, remaining[0]!.id)
  })
}
export function setDefaultPromptPreset(id: string) {
  getPromptPreset(id)
  setSetting(SETTING_KEYS.defaultPromptPresetId, id)
}
export function duplicatePromptPreset(id: string) {
  const preset = getPromptPreset(id)
  return createPromptPreset({ name: `${preset.name} 副本`, data: preset.data })
}
export function importPromptPreset(bytes: Uint8Array, fileName: string) {
  try {
    const data = importSTPreset(JSON.parse(new TextDecoder().decode(bytes)))
    return createPromptPreset({ name: fileName.replace(/\.[^.]+$/, '') || '导入预设', data })
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof STFormatError)
      throw new HttpError(400, 'BAD_PRESET', '无法解析生成预设文件')
    throw error
  }
}
export function exportPromptPreset(id: string) {
  const preset = getPromptPreset(id)
  return {
    bytes: new TextEncoder().encode(JSON.stringify(exportSTPreset(preset.data), null, 2)),
    fileName: `${preset.name}.json`,
    contentType: 'application/json',
  }
}
