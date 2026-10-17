import { type GroupDTO, type GroupInput, groupInput } from '@ai-parter/shared'
import { asc, desc, eq } from 'drizzle-orm'
import { db, newId } from '../db/client'
import { characters, groupMembers, groups } from '../db/schema'
import { HttpError, notFound } from '../errors'
import { t } from '../i18n'
import { avatarUrl } from '../lib/files'

export function getGroup(id: string): GroupDTO {
  const row = db.select().from(groups).where(eq(groups.id, id)).get()
  if (!row) throw notFound(t('群组'))
  const members = db
    .select({ character: characters, muted: groupMembers.muted })
    .from(groupMembers)
    .innerJoin(characters, eq(characters.id, groupMembers.characterId))
    .where(eq(groupMembers.groupId, id))
    .orderBy(asc(groupMembers.position))
    .all()
    .map(({ character, muted }) => ({
      characterId: character.id,
      name: character.name,
      avatarUrl: avatarUrl(character.avatarFile, character.updatedAt),
      muted,
      talkativeness: character.talkativeness,
    }))
  return {
    id: row.id,
    name: row.name,
    activation: row.activation,
    generationMode: row.generationMode,
    allowSelfResponses: row.allowSelfResponses,
    autoMode: row.autoMode,
    scenarioOverride: row.scenarioOverride,
    updatedAt: row.updatedAt,
    members,
  }
}
export function listGroups(): GroupDTO[] {
  return db
    .select({ id: groups.id })
    .from(groups)
    .orderBy(desc(groups.updatedAt), desc(groups.id))
    .all()
    .map((row) => getGroup(row.id))
}
function replaceMembers(id: string, members: NonNullable<GroupInput['members']>) {
  if (new Set(members.map((member) => member.characterId)).size !== members.length)
    throw new HttpError(400, 'VALIDATION', t('群组成员不能重复'))
  for (const member of members) {
    if (!db.select().from(characters).where(eq(characters.id, member.characterId)).get()) throw notFound(t('角色'))
  }
  db.delete(groupMembers).where(eq(groupMembers.groupId, id)).run()
  members.forEach((member, position) => {
    db.insert(groupMembers)
      .values({ groupId: id, ...member, position })
      .run()
  })
}
export function createGroup(input: GroupInput): GroupDTO {
  const { members, ...data } = groupInput.parse(input)
  return db.transaction(() => {
    const id = newId()
    const now = Date.now()
    db.insert(groups)
      .values({ ...data, id, createdAt: now, updatedAt: now })
      .run()
    replaceMembers(id, members)
    return getGroup(id)
  })
}
export function updateGroup(id: string, input: Partial<GroupInput>): GroupDTO {
  getGroup(id)
  const data = groupInput.partial().parse(input)
  // Zod 4 的 partial 仍可能填默认值；PATCH 只保留客户端实际传入的字段。
  for (const key of Object.keys(data) as (keyof typeof data)[]) {
    if (!Object.hasOwn(input, key)) delete data[key]
  }
  const { members, ...fields } = data
  return db.transaction(() => {
    if (members !== undefined) replaceMembers(id, members)
    db.update(groups)
      .set({ ...fields, updatedAt: Date.now() })
      .where(eq(groups.id, id))
      .run()
    return getGroup(id)
  })
}
export function deleteGroup(id: string) {
  getGroup(id)
  db.delete(groups).where(eq(groups.id, id)).run()
}
