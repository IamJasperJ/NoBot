import {
  type PersonaDTO,
  type PersonaInput,
  type PersonaUpdateInput,
  personaInput,
  personaUpdateInput,
} from '@ai-parter/shared'
import { asc, eq } from 'drizzle-orm'
import { db, getSetting, newId, setSetting } from '../db/client'
import { lorebooks, type PersonaRow, personas } from '../db/schema'
import { HttpError, notFound } from '../errors'
import { avatarUrl, deleteAvatar, saveAvatar } from '../lib/files'
import { SETTING_KEYS } from './settings'

function getRow(id: string): PersonaRow {
  const row = db.select().from(personas).where(eq(personas.id, id)).get()
  if (!row) throw notFound('人设')
  return row
}
function toDTO(row: PersonaRow): PersonaDTO {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    lorebookId: row.lorebookId,
    avatarUrl: avatarUrl(row.avatarFile, row.updatedAt),
    isDefault: row.id === getSetting(SETTING_KEYS.defaultPersonaId),
  }
}
function checkBook(id: string | null | undefined) {
  if (id !== null && id !== undefined && !db.select().from(lorebooks).where(eq(lorebooks.id, id)).get())
    throw notFound('世界书')
}
export function listPersonas(): PersonaDTO[] {
  return db.select().from(personas).orderBy(asc(personas.createdAt), asc(personas.id)).all().map(toDTO)
}
export function resolvePersona(id: string | null): PersonaRow {
  const target = id ?? getSetting<string>(SETTING_KEYS.defaultPersonaId)
  return (
    (target ? db.select().from(personas).where(eq(personas.id, target)).get() : undefined) ?? {
      id: '',
      name: '旅人',
      description: '',
      avatarFile: null,
      lorebookId: null,
      createdAt: 0,
      updatedAt: 0,
    }
  )
}
export function createPersona(input: PersonaInput): PersonaDTO {
  const data = personaInput.parse(input)
  checkBook(data.lorebookId)
  const id = newId()
  const now = Date.now()
  db.transaction(() => {
    db.insert(personas)
      .values({ ...data, id, createdAt: now, updatedAt: now })
      .run()
    if (!getSetting(SETTING_KEYS.defaultPersonaId)) setSetting(SETTING_KEYS.defaultPersonaId, id)
  })
  return toDTO(getRow(id))
}
export function updatePersona(id: string, input: PersonaUpdateInput): PersonaDTO {
  getRow(id)
  const data = personaUpdateInput.parse(input)
  // Zod 4 的 partial 仍可能填默认值；PATCH 只保留客户端实际传入的字段。
  for (const key of Object.keys(data) as (keyof typeof data)[]) {
    if (!Object.hasOwn(input, key)) delete data[key]
  }
  checkBook(data.lorebookId)
  db.update(personas)
    .set({ ...data, updatedAt: Date.now() })
    .where(eq(personas.id, id))
    .run()
  return toDTO(getRow(id))
}
export async function deletePersona(id: string) {
  const row = getRow(id)
  db.transaction(() => {
    const remaining = listPersonas().filter((row) => row.id !== id)
    if (!remaining.length) throw new HttpError(400, 'LAST_PERSONA', '不能删除最后一个人设')
    db.delete(personas).where(eq(personas.id, id)).run()
    if (getSetting(SETTING_KEYS.defaultPersonaId) === id) setSetting(SETTING_KEYS.defaultPersonaId, remaining[0]!.id)
  })
  await deleteAvatar(row.avatarFile)
}
export function setDefaultPersona(id: string) {
  getRow(id)
  setSetting(SETTING_KEYS.defaultPersonaId, id)
}
export async function setPersonaAvatar(id: string, bytes: Uint8Array) {
  const row = getRow(id)
  const avatarFile = await saveAvatar(id, bytes)
  db.update(personas)
    .set({ avatarFile, updatedAt: Math.max(Date.now(), row.updatedAt + 1) })
    .where(eq(personas.id, id))
    .run()
  return toDTO(getRow(id))
}
export async function removePersonaAvatar(id: string) {
  const row = getRow(id)
  await deleteAvatar(row.avatarFile)
  db.update(personas).set({ avatarFile: null, updatedAt: Date.now() }).where(eq(personas.id, id)).run()
  return toDTO(getRow(id))
}
