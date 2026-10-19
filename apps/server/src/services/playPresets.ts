import { type PlayPresetDTO, type PlayPresetInput, playPresetDataSchema, playPresetInput } from '@nobot/shared'
import { asc, eq } from 'drizzle-orm'
import { db, getSetting, newId, setSetting } from '../db/client'
import { chats, playPresets } from '../db/schema'
import { HttpError, notFound } from '../errors'
import { t } from '../i18n'
import { translateMetadata } from '../i18n/metadata'
import { builtinDefinition, translateBuiltinStateLabels } from './playPresets.builtin'
import { SETTING_KEYS } from './settings'

export function listPlayPresets(): PlayPresetDTO[] {
  const defaultId = getDefaultPlayPresetId()
  return db
    .select()
    .from(playPresets)
    .orderBy(asc(playPresets.createdAt), asc(playPresets.id))
    .all()
    .map((row) => ({
      id: row.id,
      builtin: row.builtinKey !== null,
      name: row.name === builtinDefinition(row.builtinKey)?.name ? translateMetadata(row.name) : row.name,
      data: translateBuiltinStateLabels(row.builtinKey, playPresetDataSchema.parse(row.data)),
      updatedAt: row.updatedAt,
      isDefault: row.id === defaultId,
    }))
}
export function getPlayPreset(id: string): PlayPresetDTO {
  const preset = listPlayPresets().find((row) => row.id === id)
  if (!preset) throw notFound(t('玩法预设'))
  return preset
}
export function createPlayPreset(input: PlayPresetInput): PlayPresetDTO {
  const data = playPresetInput.parse(input)
  const id = newId()
  const now = Date.now()
  db.transaction(() => {
    db.insert(playPresets)
      .values({ ...data, id, createdAt: now, updatedAt: now })
      .run()
    if (!getSetting(SETTING_KEYS.defaultPlayPresetId)) setSetting(SETTING_KEYS.defaultPlayPresetId, id)
  })
  return getPlayPreset(id)
}
export function updatePlayPreset(id: string, input: Partial<PlayPresetInput>): PlayPresetDTO {
  getPlayPreset(id)
  const data = playPresetInput.partial().parse(input)
  // Zod 4 的 partial 仍可能填默认值；PATCH 只保留客户端实际传入的字段。
  for (const key of Object.keys(data) as (keyof typeof data)[]) {
    if (!Object.hasOwn(input, key)) delete data[key]
  }
  db.update(playPresets)
    .set({ ...data, updatedAt: Date.now() })
    .where(eq(playPresets.id, id))
    .run()
  return getPlayPreset(id)
}
export function deletePlayPreset(id: string) {
  db.transaction(() => {
    const preset = getPlayPreset(id)
    const remaining = listPlayPresets().filter((row) => row.id !== id)
    if (!remaining.length) throw new HttpError(400, 'LAST_PLAY_PRESET', t('不能删除最后一个玩法预设'))
    db.update(chats).set({ playPresetId: null }).where(eq(chats.playPresetId, id)).run()
    db.delete(playPresets).where(eq(playPresets.id, id)).run()
    if (preset.isDefault) setSetting(SETTING_KEYS.defaultPlayPresetId, remaining[0]!.id)
  })
}
export function setDefaultPlayPreset(id: string) {
  getPlayPreset(id)
  setSetting(SETTING_KEYS.defaultPlayPresetId, id)
}
export function duplicatePlayPreset(id: string) {
  const preset = getPlayPreset(id)
  return createPlayPreset({ name: t('{name} 副本', { name: preset.name }), data: preset.data })
}
/** 内置预设恢复成内置默认（名字和全部设置）。用户自己建的预设不能重置 */
export function resetPlayPreset(id: string): PlayPresetDTO {
  getPlayPreset(id)
  const row = db.select({ key: playPresets.builtinKey }).from(playPresets).where(eq(playPresets.id, id)).get()
  const def = builtinDefinition(row?.key ?? null)
  if (!def) throw new HttpError(400, 'NOT_BUILTIN', t('只有内置预设可以重置'))
  db.update(playPresets)
    .set({ name: def.name, data: def.build(), updatedAt: Date.now() })
    .where(eq(playPresets.id, id))
    .run()
  return getPlayPreset(id)
}
export function getDefaultPlayPresetId(): string | undefined {
  const rows = db.select().from(playPresets).orderBy(asc(playPresets.createdAt), asc(playPresets.id)).all()
  const id = getSetting<string>(SETTING_KEYS.defaultPlayPresetId)
  return rows.find((row) => row.id === id)?.id ?? rows[0]?.id
}
export function getDefault() {
  const id = getDefaultPlayPresetId()
  if (!id) throw notFound(t('玩法预设'))
  return getPlayPreset(id)
}
export function importJson(bytes: Uint8Array) {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'nobot-play-preset')
      throw new Error(t('格式错误'))
    const parsed = playPresetInput.parse(value)
    return createPlayPreset(parsed)
  } catch {
    throw new HttpError(400, 'BAD_PLAY_PRESET', t('无法解析玩法预设文件'))
  }
}
export function exportJson(id: string) {
  const preset = getPlayPreset(id)
  return {
    bytes: new TextEncoder().encode(
      JSON.stringify({ type: 'nobot-play-preset', version: 1, name: preset.name, data: preset.data }, null, 2),
    ),
    fileName: `${preset.name}.json`,
    contentType: 'application/json',
  }
}
export {
  createPlayPreset as create,
  deletePlayPreset as delete,
  duplicatePlayPreset as duplicate,
  getPlayPreset as get,
  listPlayPresets as list,
  resetPlayPreset as reset,
  setDefaultPlayPreset as setDefault,
  updatePlayPreset as update,
}
