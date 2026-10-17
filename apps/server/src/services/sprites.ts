import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spriteNameFromPath } from '@ai-parter/core/stage'
import { type SpriteDTO, type SpriteImportResult, updateSpriteInput } from '@ai-parter/shared'
import { and, asc, eq } from 'drizzle-orm'
import sharp, { type Metadata } from 'sharp'
import { db, newId } from '../db/client'
import { characters, sprites } from '../db/schema'
import { paths } from '../env'
import { HttpError, notFound } from '../errors'
import { readZip } from '../lib/zip'

type SpriteRow = typeof sprites.$inferSelect
export function requireCharacter(id: string) {
  if (!db.select({ id: characters.id }).from(characters).where(eq(characters.id, id)).get()) throw notFound('角色')
}
function dto(row: SpriteRow): SpriteDTO {
  const base = `/api/assets/sprites/${row.characterId}/${row.id}`
  return {
    id: row.id,
    characterId: row.characterId,
    outfit: row.outfit,
    expression: row.expression,
    width: row.width,
    height: row.height,
    createdAt: row.createdAt,
    url: `${base}.${row.ext}`,
    thumbUrl: `${base}.thumb.webp`,
  }
}
export function listSprites(characterId: string): SpriteDTO[] {
  requireCharacter(characterId)
  return db
    .select()
    .from(sprites)
    .where(eq(sprites.characterId, characterId))
    .orderBy(asc(sprites.outfit), asc(sprites.expression), asc(sprites.createdAt), asc(sprites.id))
    .all()
    .map(dto)
}
export async function saveSprite(characterId: string, bytes: Uint8Array, outfit: string, expression: string) {
  requireCharacter(characterId)
  const names = updateSpriteInput.parse({ outfit, expression })
  if (bytes.length > 20 * 1024 * 1024) throw new HttpError(400, 'TOO_LARGE', '单张立绘不能超过 20 MB')
  let metadata: Metadata
  let thumbnail: Buffer
  try {
    metadata = await sharp(bytes).metadata()
    if (!['png', 'webp', 'gif', 'jpeg'].includes(metadata.format ?? '') || !metadata.width || !metadata.height)
      throw new Error('不是支持的图片')
    thumbnail = await sharp(bytes).resize({ height: 256 }).webp().toBuffer()
  } catch {
    throw new HttpError(400, 'BAD_IMAGE', '不是图片或不支持的图片格式')
  }
  const row: SpriteRow = {
    id: newId(),
    characterId,
    outfit: names.outfit!,
    expression: names.expression!,
    ext: (metadata.format === 'jpeg' ? 'jpg' : metadata.format) as SpriteRow['ext'],
    width: metadata.width!,
    height: metadata.height!,
    createdAt: Date.now(),
  }
  const directory = join(paths.sprites, characterId)
  const original = join(directory, `${row.id}.${row.ext}`)
  const thumb = join(directory, `${row.id}.thumb.webp`)
  await mkdir(directory, { recursive: true })
  try {
    await Bun.write(original, bytes)
    await Bun.write(thumb, thumbnail)
    // 写文件期间角色可能被删除，插入前重新检查并让外键兜底。
    requireCharacter(characterId)
    db.insert(sprites).values(row).run()
    return dto(row)
  } catch (error) {
    await Promise.all([rm(original, { force: true }), rm(thumb, { force: true })])
    throw error
  }
}
export async function importSprites(
  characterId: string,
  entries: { path: string; data: Uint8Array }[],
  overrides?: { outfit?: string; expression?: string },
): Promise<SpriteImportResult> {
  requireCharacter(characterId)
  const result: SpriteImportResult = { added: [], skipped: [] }
  for (const entry of entries) {
    const name = spriteNameFromPath(overrides ? entry.path.split(/[\\/]/).at(-1)! : entry.path)
    if (!overrides && !/\.(png|webp|gif|jpe?g)$/i.test(entry.path)) {
      result.skipped.push(`${entry.path}：不是图片`)
      continue
    }
    const expression = overrides?.expression ?? name?.expression
    if (!expression) {
      result.skipped.push(`${entry.path}：无法从文件名判断表情，请在对应格子里上传`)
      continue
    }
    try {
      result.added.push(await saveSprite(characterId, entry.data, overrides?.outfit ?? name?.outfit ?? '', expression))
    } catch (error) {
      result.skipped.push(`${entry.path}：${error instanceof Error ? error.message : '导入失败'}`)
    }
  }
  return result
}
export const importSpriteZip = (id: string, bytes: Uint8Array) => importSprites(id, readZip(bytes))
function findSprite(characterId: string, id: string) {
  requireCharacter(characterId)
  const row = db
    .select()
    .from(sprites)
    .where(and(eq(sprites.id, id), eq(sprites.characterId, characterId)))
    .get()
  if (!row) throw notFound('立绘')
  return row
}
export function updateSprite(characterId: string, id: string, input: unknown) {
  const row = findSprite(characterId, id)
  const data = updateSpriteInput.parse(input)
  if (Object.keys(data).length) db.update(sprites).set(data).where(eq(sprites.id, id)).run()
  return dto({ ...row, ...data })
}
export async function deleteSprite(characterId: string, id: string) {
  const row = findSprite(characterId, id)
  db.delete(sprites).where(eq(sprites.id, id)).run()
  await Promise.all(
    [`${id}.${row.ext}`, `${id}.thumb.webp`].map((file) => rm(join(paths.sprites, characterId, file), { force: true })),
  )
}
export async function deleteOutfit(characterId: string, outfit: string) {
  requireCharacter(characterId)
  const rows = db
    .select()
    .from(sprites)
    .where(and(eq(sprites.characterId, characterId), eq(sprites.outfit, outfit)))
    .all()
  for (const row of rows) await deleteSprite(characterId, row.id)
  return { deleted: rows.length }
}
