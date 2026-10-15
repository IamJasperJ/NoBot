import type { PersonaDTO, PersonaInput } from '@ai-parter/shared'
import { asc, eq } from 'drizzle-orm'
import { db, getSetting } from '../db/client'
import { type PersonaRow, personas } from '../db/schema'
import { notFound } from '../errors'

function toDTO(row: PersonaRow): PersonaDTO {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isDefault: row.id === getSetting<string>('defaultPersonaId'),
  }
}

export function listPersonas(): PersonaDTO[] {
  return db.select().from(personas).orderBy(asc(personas.createdAt)).all().map(toDTO)
}

/** 会话没有绑定人设（或人设被删了）时，退回默认人设 */
export function resolvePersona(id: string | null): PersonaRow {
  const target = id ?? getSetting<string>('defaultPersonaId')
  const row = target ? db.select().from(personas).where(eq(personas.id, target)).get() : undefined
  return row ?? { id: '', name: '旅人', description: '', createdAt: 0, updatedAt: 0 }
}

export function updatePersona(id: string, input: PersonaInput): PersonaDTO {
  const existing = db.select().from(personas).where(eq(personas.id, id)).get()
  if (!existing) throw notFound('人设')
  db.update(personas)
    .set({ ...input, updatedAt: Date.now() })
    .where(eq(personas.id, id))
    .run()
  return toDTO({ ...existing, ...input })
}
