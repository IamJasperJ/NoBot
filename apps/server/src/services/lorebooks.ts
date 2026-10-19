import { exportSTWorldInfo, importSTWorldInfo, STFormatError } from '@nobot/core'
import {
  type LorebookDTO,
  type LorebookEntryData,
  type LorebookEntryDTO,
  type LorebookInput,
  lorebookEntryDataSchema,
  lorebookInput,
} from '@nobot/shared'
import { asc, desc, eq } from 'drizzle-orm'
import { db, newId } from '../db/client'
import { type LorebookEntryRow, type LorebookRow, lorebookEntries, lorebooks } from '../db/schema'
import { HttpError, notFound } from '../errors'
import { t } from '../i18n'
import { requireBackground } from './backgrounds'

function getRow(id: string) {
  const row = db.select().from(lorebooks).where(eq(lorebooks.id, id)).get()
  if (!row) throw notFound(t('世界书'))
  return row
}
function rows(id: string) {
  return db
    .select()
    .from(lorebookEntries)
    .where(eq(lorebookEntries.lorebookId, id))
    .orderBy(asc(lorebookEntries.sort), asc(lorebookEntries.id))
    .all()
}
function toDTO(row: LorebookRow): LorebookDTO {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isGlobal: row.isGlobal,
    updatedAt: row.updatedAt,
    entryCount: rows(row.id).length,
  }
}
function entryDTO(row: LorebookEntryRow): LorebookEntryDTO {
  return { ...lorebookEntryDataSchema.parse(row.data), id: row.id, lorebookId: row.lorebookId }
}
function entryRow(id: string) {
  const row = db.select().from(lorebookEntries).where(eq(lorebookEntries.id, id)).get()
  if (!row) throw notFound(t('世界书条目'))
  return row
}
function touch(id: string) {
  db.update(lorebooks).set({ updatedAt: Date.now() }).where(eq(lorebooks.id, id)).run()
}
export function listLorebooks(): LorebookDTO[] {
  return db.select().from(lorebooks).orderBy(desc(lorebooks.updatedAt), desc(lorebooks.id)).all().map(toDTO)
}
export function createLorebook(input: LorebookInput): LorebookDTO {
  const data = lorebookInput.parse(input)
  const id = newId()
  const now = Date.now()
  db.insert(lorebooks)
    .values({ ...data, id, createdAt: now, updatedAt: now })
    .run()
  return toDTO(getRow(id))
}
export function getLorebookWithEntries(id: string) {
  return { lorebook: toDTO(getRow(id)), entries: rows(id).map(entryDTO) }
}
export function updateLorebook(id: string, input: Partial<LorebookInput>): LorebookDTO {
  getRow(id)
  const data = lorebookInput.partial().parse(input)
  // Zod 4 的 partial 仍可能填默认值；PATCH 只保留客户端实际传入的字段。
  for (const key of Object.keys(data) as (keyof typeof data)[]) {
    if (!Object.hasOwn(input, key)) delete data[key]
  }
  db.update(lorebooks)
    .set({ ...data, updatedAt: Date.now() })
    .where(eq(lorebooks.id, id))
    .run()
  return toDTO(getRow(id))
}
export function deleteLorebook(id: string) {
  getRow(id)
  db.delete(lorebooks).where(eq(lorebooks.id, id)).run()
}
export function createEntry(id: string, input: Partial<LorebookEntryData>): LorebookEntryDTO {
  return db.transaction(() => {
    getRow(id)
    if (input.backgroundId != null) requireBackground(input.backgroundId)
    const entries = rows(id)
    const entryId = newId()
    db.insert(lorebookEntries)
      .values({
        id: entryId,
        lorebookId: id,
        sort: (entries.at(-1)?.sort ?? -1) + 1,
        data: lorebookEntryDataSchema.parse(input),
      })
      .run()
    touch(id)
    return entryDTO(entryRow(entryId))
  })
}
export function updateEntry(id: string, input: Partial<LorebookEntryData>): LorebookEntryDTO {
  return db.transaction(() => {
    const row = entryRow(id)
    const patch = lorebookEntryDataSchema.partial().parse(input)
    for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
      if (!Object.hasOwn(input, key)) delete patch[key]
    }
    const data = lorebookEntryDataSchema.parse({ ...lorebookEntryDataSchema.parse(row.data), ...patch })
    if (data.backgroundId != null) requireBackground(data.backgroundId)
    db.update(lorebookEntries).set({ data }).where(eq(lorebookEntries.id, id)).run()
    touch(row.lorebookId)
    return entryDTO(entryRow(id))
  })
}
export function deleteEntry(id: string) {
  db.transaction(() => {
    const row = entryRow(id)
    db.delete(lorebookEntries).where(eq(lorebookEntries.id, id)).run()
    touch(row.lorebookId)
  })
}
export function reorderEntries(id: string, ids: string[]) {
  db.transaction(() => {
    getRow(id)
    const entries = rows(id)
    if (
      ids.length !== entries.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !entries.some((row) => row.id === id))
    ) {
      throw new HttpError(400, 'BAD_REQUEST', t('排序必须包含本世界书全部条目，且不能重复'))
    }
    ids.forEach((id, sort) => {
      db.update(lorebookEntries).set({ sort }).where(eq(lorebookEntries.id, id)).run()
    })
    touch(id)
  })
}
export function importLorebook(bytes: Uint8Array, fileName: string): LorebookDTO {
  try {
    const imported = importSTWorldInfo(JSON.parse(new TextDecoder().decode(bytes)))
    return db.transaction(() => {
      const book = createLorebook({
        name: imported.name?.trim() || fileName.replace(/\.[^.]+$/, '') || t('导入世界书'),
      })
      imported.entries.forEach((entry) => {
        createEntry(book.id, entry)
      })
      return getLorebookWithEntries(book.id).lorebook
    })
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof STFormatError)
      throw new HttpError(400, 'BAD_LOREBOOK', t('无法解析世界书文件'))
    throw error
  }
}
export function exportLorebook(id: string) {
  const { lorebook, entries } = getLorebookWithEntries(id)
  const data = {
    name: lorebook.name,
    ...exportSTWorldInfo(entries.map((entry) => lorebookEntryDataSchema.parse(entry))),
  }
  return {
    bytes: new TextEncoder().encode(JSON.stringify(data, null, 2)),
    fileName: `${lorebook.name}.json`,
    contentType: 'application/json',
  }
}
