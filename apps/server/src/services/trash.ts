import type { TrashDTO, TrashItemDTO, UsageDTO } from '@ai-parter/shared'
import { and, count, eq, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../db/client'
import { characters, chats, groupMembers, groups } from '../db/schema'
import { notFound } from '../errors'
import { t } from '../i18n'
import { avatarUrl } from '../lib/files'
import { getCharacterRow, hardDeleteCharacter } from './characters'
import { getGroup } from './groups'

type TrashKind = 'character' | 'group'

function chatCount(kind: TrashKind, id: string): number {
  return db
    .select({ total: count() })
    .from(chats)
    .where(eq(kind === 'character' ? chats.characterId : chats.groupId, id))
    .get()!.total
}

export function characterUsage(id: string): UsageDTO {
  getCharacterRow(id)
  return {
    chats: chatCount('character', id),
    groups: db
      .select({ id: groups.id, name: groups.name })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(and(eq(groupMembers.characterId, id), isNull(groups.deletedAt)))
      .all(),
  }
}

export function groupUsage(id: string): UsageDTO {
  getGroup(id)
  return { chats: chatCount('group', id), groups: [] }
}

export function listTrash(): TrashDTO {
  const items: TrashItemDTO[] = [
    ...db
      .select()
      .from(characters)
      .where(isNotNull(characters.deletedAt))
      .all()
      .map(
        (row): TrashItemDTO => ({
          id: row.id,
          kind: 'character',
          name: row.name,
          avatarUrl: avatarUrl(row.avatarFile, row.updatedAt),
          deletedAt: row.deletedAt!,
          chats: chatCount('character', row.id),
        }),
      ),
    ...db
      .select()
      .from(groups)
      .where(isNotNull(groups.deletedAt))
      .all()
      .map(
        (row): TrashItemDTO => ({
          id: row.id,
          kind: 'group',
          name: row.name,
          avatarUrl: null,
          deletedAt: row.deletedAt!,
          chats: chatCount('group', row.id),
        }),
      ),
  ]
  return { items: items.sort((a, b) => b.deletedAt - a.deletedAt || b.id.localeCompare(a.id)) }
}

function requireDeletedCharacter(id: string) {
  const row = db
    .select()
    .from(characters)
    .where(and(eq(characters.id, id), isNotNull(characters.deletedAt)))
    .get()
  if (!row) throw notFound(t('角色'))
  return row
}

function requireDeletedGroup(id: string) {
  const row = db
    .select()
    .from(groups)
    .where(and(eq(groups.id, id), isNotNull(groups.deletedAt)))
    .get()
  if (!row) throw notFound(t('群组'))
  return row
}

export function restoreTrash(kind: TrashKind, id: string) {
  if (kind === 'character') {
    requireDeletedCharacter(id)
    db.update(characters).set({ deletedAt: null }).where(eq(characters.id, id)).run()
  } else {
    requireDeletedGroup(id)
    db.update(groups).set({ deletedAt: null }).where(eq(groups.id, id)).run()
  }
}

export async function purgeTrash(kind: TrashKind, id: string) {
  if (kind === 'character') {
    await hardDeleteCharacter(requireDeletedCharacter(id))
  } else {
    requireDeletedGroup(id)
    db.delete(groups).where(eq(groups.id, id)).run()
  }
}

export async function emptyTrash(): Promise<number> {
  const { items } = listTrash()
  for (const item of items) await purgeTrash(item.kind, item.id)
  return items.length
}
