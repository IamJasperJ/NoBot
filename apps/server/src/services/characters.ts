import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  buildCardExport,
  CardParseError,
  importSTWorldInfo,
  isPng,
  parseCardFile,
  parseCardJson,
  STFormatError,
  writePngTextChunks,
} from '@ai-parter/core'
import {
  type CharacterDTO,
  type CharacterFields,
  type CharacterImportLorebook,
  type CharacterImportPreview,
  type CharacterInput,
  type CharacterSummary,
  type CharacterUpdateInput,
  characterInput,
  characterUpdateInput,
  lorebookEntryDataSchema,
} from '@ai-parter/shared'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import sharp from 'sharp'
import { db, newId } from '../db/client'
import { type CharacterRow, characterLorebooks, characters, lorebooks, personas } from '../db/schema'
import { paths } from '../env'
import { cardParseMessage, HttpError, notFound } from '../errors'
import { t } from '../i18n'
import { readCharx } from '../lib/charx'
import { avatarUrl, deleteAvatar, readAvatar, saveAvatar } from '../lib/files'
import { requireBackground } from './backgrounds'
import { createEntry, createLorebook, getLorebookWithEntries } from './lorebooks'
import { getProfile } from './profiles'
import { quickReplyScope, setQuickReplyScope } from './quick-replies'
import { saveSprite } from './sprites'

export function toSummary(row: CharacterRow): CharacterSummary {
  return {
    id: row.id,
    name: row.name,
    avatarUrl: avatarUrl(row.avatarFile, row.updatedAt),
    tags: row.tags,
    updatedAt: row.updatedAt,
  }
}
export function toFields(row: CharacterRow): CharacterFields {
  return {
    name: row.name,
    description: row.description,
    personality: row.personality,
    scenario: row.scenario,
    first_mes: row.firstMes,
    alternate_greetings: row.alternateGreetings,
    mes_example: row.mesExample,
    system_prompt: row.systemPrompt,
    post_history_instructions: row.postHistoryInstructions,
    creator_notes: row.creatorNotes,
    creator: row.creator,
    character_version: row.characterVersion,
    tags: row.tags,
  }
}
function fromFields(fields: CharacterFields) {
  const {
    first_mes,
    alternate_greetings,
    mes_example,
    system_prompt,
    post_history_instructions,
    creator_notes,
    character_version,
    ...rest
  } = fields
  return {
    ...rest,
    firstMes: first_mes,
    alternateGreetings: alternate_greetings,
    mesExample: mes_example,
    systemPrompt: system_prompt,
    postHistoryInstructions: post_history_instructions,
    creatorNotes: creator_notes,
    characterVersion: character_version,
  }
}
export function getCharacterRow(id: string): CharacterRow {
  const row = db
    .select()
    .from(characters)
    .where(and(eq(characters.id, id), isNull(characters.deletedAt)))
    .get()
  if (!row) throw notFound(t('角色'))
  return row
}
export function getCharacter(id: string): CharacterDTO {
  const row = getCharacterRow(id)
  return {
    ...toFields(row),
    ...(quickReplyScope('character', id).length ? { quickReplySetIds: quickReplyScope('character', id) } : {}),
    id,
    avatarUrl: avatarUrl(row.avatarFile, row.updatedAt),
    extensions: row.extensions,
    talkativeness: row.talkativeness,
    characterNote: row.characterNote,
    characterNoteDepth: row.characterNoteDepth,
    characterNoteRole: row.characterNoteRole,
    profileId: row.profileId,
    defaultPersonaId: row.defaultPersonaId,
    defaultBackgroundId: row.defaultBackgroundId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lorebookIds: db
      .select()
      .from(characterLorebooks)
      .where(eq(characterLorebooks.characterId, id))
      .orderBy(asc(characterLorebooks.position))
      .all()
      .map((row) => row.lorebookId),
  }
}
export function listCharacters(): CharacterSummary[] {
  return db
    .select()
    .from(characters)
    .where(isNull(characters.deletedAt))
    .orderBy(desc(characters.updatedAt), desc(characters.id))
    .all()
    .map(toSummary)
}
function checkRelations(bookIds: string[], personaId: string | null) {
  if (new Set(bookIds).size !== bookIds.length) throw new HttpError(400, 'VALIDATION', t('关联世界书不能重复'))
  for (const id of bookIds)
    if (!db.select().from(lorebooks).where(eq(lorebooks.id, id)).get()) throw notFound(t('世界书'))
  if (personaId !== null && !db.select().from(personas).where(eq(personas.id, personaId)).get())
    throw notFound(t('人设'))
}
function replaceBooks(id: string, ids: string[]) {
  db.delete(characterLorebooks).where(eq(characterLorebooks.characterId, id)).run()
  ids.forEach((lorebookId, position) => {
    db.insert(characterLorebooks).values({ characterId: id, lorebookId, position }).run()
  })
}
export function createCharacter(input: CharacterInput): CharacterDTO {
  const {
    lorebookIds,
    talkativeness,
    characterNote,
    characterNoteDepth,
    characterNoteRole,
    defaultPersonaId,
    profileId,
    defaultBackgroundId,
    extensions,
    ...fields
  } = characterInput.parse(input)
  if (profileId) getProfile(profileId)
  if (defaultBackgroundId !== null) requireBackground(defaultBackgroundId)
  checkRelations(lorebookIds, defaultPersonaId)
  return db.transaction(() => {
    const id = newId()
    const now = Date.now()
    db.insert(characters)
      .values({
        ...fromFields(fields),
        talkativeness,
        characterNote,
        characterNoteDepth,
        characterNoteRole,
        defaultPersonaId,
        profileId,
        defaultBackgroundId,
        extensions,
        id,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    replaceBooks(id, lorebookIds)
    return getCharacter(id)
  })
}
export function updateCharacter(id: string, input: CharacterUpdateInput): CharacterDTO {
  const old = getCharacter(id)
  const data = characterUpdateInput.parse(input)
  // Zod 4 的 partial 仍可能填默认值；PATCH 只保留客户端实际传入的字段。
  for (const key of Object.keys(data) as (keyof typeof data)[]) {
    if (!Object.hasOwn(input, key)) delete data[key]
  }
  const merged = characterInput.parse({ ...old, ...data })
  const {
    lorebookIds,
    talkativeness,
    characterNote,
    characterNoteDepth,
    characterNoteRole,
    defaultPersonaId,
    profileId,
    defaultBackgroundId,
    extensions,
    ...fields
  } = merged
  if (profileId) getProfile(profileId)
  if (defaultBackgroundId !== null) requireBackground(defaultBackgroundId)
  checkRelations(lorebookIds, defaultPersonaId)
  return db.transaction(() => {
    if (data.quickReplySetIds) setQuickReplyScope('character', id, data.quickReplySetIds)
    db.update(characters)
      .set({
        ...fromFields(fields),
        talkativeness,
        characterNote,
        characterNoteDepth,
        characterNoteRole,
        defaultPersonaId,
        profileId,
        defaultBackgroundId,
        extensions,
        updatedAt: Date.now(),
      })
      .where(eq(characters.id, id))
      .run()
    if (input.lorebookIds !== undefined) replaceBooks(id, lorebookIds)
    return getCharacter(id)
  })
}
function parseImport(bytes: Uint8Array, includeBook = true) {
  let card: ReturnType<typeof parseCardFile>
  let book: ReturnType<typeof importSTWorldInfo> | null
  let charx: ReturnType<typeof readCharx>
  try {
    charx = readCharx(bytes)
    card = charx?.card ?? parseCardFile(bytes)
    book = includeBook && card.characterBook ? importSTWorldInfo(card.characterBook) : null
  } catch (error) {
    if (error instanceof CardParseError || error instanceof STFormatError)
      throw new HttpError(400, 'BAD_CARD', t('角色卡无法导入：{error}', { error: cardParseMessage(error.message) }))
    throw error
  }
  return { card, book, charx }
}

export function previewCharacterImport(bytes: Uint8Array): CharacterImportPreview {
  const { card, book, charx } = parseImport(bytes)
  return {
    name: card.fields.name,
    spec: card.spec,
    hasAvatar: isPng(bytes) || !!charx?.avatar,
    lorebook: book
      ? { name: book.name?.trim() || t('{name} 的世界书', { name: card.fields.name }), entryCount: book.entries.length }
      : null,
  }
}

export async function importCharacter(
  bytes: Uint8Array,
  lorebook: CharacterImportLorebook = 'skip',
): Promise<CharacterDTO> {
  const { card, book, charx } = parseImport(bytes, lorebook !== 'skip')
  const id = newId()
  const avatar = charx?.avatar ?? (isPng(bytes) ? bytes : null)
  const avatarFile = avatar ? await saveAvatar(id, avatar) : null
  try {
    const imported = db.transaction(() => {
      const lorebookIds: string[] = []
      if (book) {
        const created = createLorebook({ name: book.name?.trim() || t('{name} 的世界书', { name: card.fields.name }) })
        book.entries.forEach((entry) => {
          createEntry(created.id, entry)
        })
        if (lorebook === 'link') lorebookIds.push(created.id)
      }
      const data = characterInput.parse({ ...card.fields, ...card.extras, extensions: card.extensions, lorebookIds })
      const {
        lorebookIds: ids,
        talkativeness,
        characterNote,
        characterNoteDepth,
        characterNoteRole,
        defaultPersonaId,
        profileId,
        defaultBackgroundId,
        extensions,
        ...fields
      } = data
      const now = Date.now()
      db.insert(characters)
        .values({
          ...fromFields(fields),
          talkativeness,
          characterNote,
          characterNoteDepth,
          characterNoteRole,
          defaultPersonaId,
          profileId,
          defaultBackgroundId,
          extensions,
          id,
          avatarFile,
          raw: card.raw,
          createdAt: now,
          updatedAt: now,
        })
        .run()
      replaceBooks(id, ids)
      return getCharacter(id)
    })
    for (const emotion of charx?.emotions ?? []) await saveSprite(id, emotion.data, '', emotion.name.toLowerCase())
    return imported
  } catch (error) {
    db.delete(characters).where(eq(characters.id, id)).run()
    await rm(join(paths.sprites, id), { recursive: true, force: true })
    await deleteAvatar(avatarFile)
    throw error
  }
}
export async function deleteCharacter(id: string) {
  getCharacterRow(id)
  db.update(characters).set({ deletedAt: Date.now() }).where(eq(characters.id, id)).run()
}
export async function hardDeleteCharacter(row: CharacterRow) {
  const id = row.id
  db.delete(characters).where(eq(characters.id, id)).run()
  await deleteAvatar(row.avatarFile)
  await rm(join(paths.sprites, id), { recursive: true, force: true })
}
export async function setCharacterAvatar(id: string, bytes: Uint8Array): Promise<CharacterDTO> {
  const row = getCharacterRow(id)
  const avatarFile = await saveAvatar(id, bytes)
  db.update(characters)
    .set({ avatarFile, updatedAt: Math.max(Date.now(), row.updatedAt + 1) })
    .where(eq(characters.id, id))
    .run()
  return getCharacter(id)
}
export async function duplicateCharacter(id: string): Promise<CharacterDTO> {
  const row = getCharacterRow(id)
  const source = getCharacter(id)
  const copy = createCharacter({ ...source, name: t('{name} 副本', { name: source.name }) })
  try {
    if (row.avatarFile)
      await setCharacterAvatar(copy.id, new Uint8Array(await readAvatar(row.avatarFile).arrayBuffer()))
    db.update(characters).set({ raw: row.raw }).where(eq(characters.id, copy.id)).run()
    return getCharacter(copy.id)
  } catch (error) {
    await hardDeleteCharacter(getCharacterRow(copy.id))
    throw error
  }
}
export async function exportCharacter(id: string, format: 'png' | 'json') {
  const row = getCharacterRow(id)
  const character = getCharacter(id)
  const primary = character.lorebookIds[0]
  const book = primary ? getLorebookWithEntries(primary) : null
  const { v2, v3 } = buildCardExport({
    fields: toFields(row),
    extras: character,
    extensions: character.extensions,
    raw: row.raw,
    book: book
      ? { name: book.lorebook.name, entries: book.entries.map((entry) => lorebookEntryDataSchema.parse(entry)) }
      : null,
  })
  // 未关联世界书时仍保留原卡内嵌数据，避免选择跳过导入后再导出丢失内容。
  if (!book && row.raw) {
    const originalBook = parseCardJson(row.raw).characterBook
    if (originalBook) {
      for (const card of [v2, v3]) {
        const data = card.data as Record<string, unknown>
        data.character_book = structuredClone(originalBook)
      }
    }
  }
  if (format === 'json')
    return {
      bytes: new TextEncoder().encode(JSON.stringify(v3, null, 2)),
      fileName: `${row.name}.json`,
      contentType: 'application/json',
    }
  const png = row.avatarFile
    ? new Uint8Array(await readAvatar(row.avatarFile).arrayBuffer())
    : await sharp({ create: { width: 400, height: 600, channels: 3, background: '#e5e7eb' } })
        .png()
        .toBuffer()
  const bytes = writePngTextChunks(png, {
    chara: Buffer.from(JSON.stringify(v2)).toString('base64'),
    ccv3: Buffer.from(JSON.stringify(v3)).toString('base64'),
  })
  return { bytes, fileName: `${row.name}.png`, contentType: 'image/png' }
}
