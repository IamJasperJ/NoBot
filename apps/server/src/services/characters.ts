import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CardParseError, isPng, parseCardFile } from '@ai-parter/core'
import type { CharacterDTO, CharacterFields, CharacterSummary, CharacterUpdateInput } from '@ai-parter/shared'
import { desc, eq } from 'drizzle-orm'
import sharp from 'sharp'
import { db, newId } from '../db/client'
import { type CharacterRow, characters } from '../db/schema'
import { paths } from '../env'
import { HttpError, notFound } from '../errors'

/**
 * 头像存两份：原图 {id}.png（导出角色卡时要用），
 * 和 256px 的 WebP 缩略图 {id}.webp（列表和聊天界面用，体积小很多）。
 */
const thumbFile = (avatarFile: string) => avatarFile.replace(/\.png$/, '.webp')
const avatarUrl = (row: CharacterRow) =>
  row.avatarFile ? `/api/assets/avatars/${thumbFile(row.avatarFile)}?v=${row.updatedAt}` : null

export function toSummary(row: CharacterRow): CharacterSummary {
  return { id: row.id, name: row.name, avatarUrl: avatarUrl(row), tags: row.tags, updatedAt: row.updatedAt }
}

/** 数据库行 → 角色卡字段（驼峰转回酒馆的下划线命名） */
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
    tags: row.tags,
  }
}

function fromFields(f: CharacterFields) {
  return {
    name: f.name,
    description: f.description,
    personality: f.personality,
    scenario: f.scenario,
    firstMes: f.first_mes,
    alternateGreetings: f.alternate_greetings,
    mesExample: f.mes_example,
    systemPrompt: f.system_prompt,
    postHistoryInstructions: f.post_history_instructions,
    creatorNotes: f.creator_notes,
    tags: f.tags,
  }
}

function toDTO(row: CharacterRow): CharacterDTO {
  return { ...toFields(row), id: row.id, avatarUrl: avatarUrl(row), createdAt: row.createdAt, updatedAt: row.updatedAt }
}

export function listCharacters(): CharacterSummary[] {
  return db.select().from(characters).orderBy(desc(characters.updatedAt)).all().map(toSummary)
}

export function getCharacterRow(id: string): CharacterRow {
  const row = db.select().from(characters).where(eq(characters.id, id)).get()
  if (!row) throw notFound('角色')
  return row
}

export const getCharacter = (id: string) => toDTO(getCharacterRow(id))

/** 导入角色卡（PNG 或 JSON） */
export async function importCharacter(bytes: Uint8Array): Promise<CharacterDTO> {
  let card: ReturnType<typeof parseCardFile>
  try {
    card = parseCardFile(bytes)
  } catch (e) {
    if (e instanceof CardParseError) throw new HttpError(400, 'BAD_CARD', e.message)
    throw e
  }

  const id = newId()
  let avatarFile: string | null = null
  if (isPng(bytes)) {
    avatarFile = `${id}.png`
    await Bun.write(join(paths.avatars, avatarFile), bytes)
    await sharp(bytes)
      .resize(256, 256, { fit: 'cover', position: 'top' })
      .webp({ quality: 82 })
      .toFile(join(paths.avatars, thumbFile(avatarFile)))
  }

  // 卡里自带的世界书（character_book）原样留在 raw 里，里程碑 5 再拆成独立世界书
  const now = Date.now()
  db.insert(characters)
    .values({
      ...fromFields(card.fields),
      id,
      avatarFile,
      raw: card.raw,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return getCharacter(id)
}

export function updateCharacter(id: string, input: CharacterUpdateInput): CharacterDTO {
  const row = getCharacterRow(id)
  // 没传的字段沿用原值
  const merged = { ...toFields(row), ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) }
  db.update(characters)
    .set({ ...fromFields(merged), updatedAt: Date.now() })
    .where(eq(characters.id, id))
    .run()
  return getCharacter(id)
}

/** 删除角色。会话和消息靠外键级联删除，头像文件手动删 */
export async function deleteCharacter(id: string) {
  const row = getCharacterRow(id)
  db.delete(characters).where(eq(characters.id, id)).run()
  if (row.avatarFile) {
    await rm(join(paths.avatars, row.avatarFile), { force: true })
    await rm(join(paths.avatars, thumbFile(row.avatarFile)), { force: true })
  }
}
