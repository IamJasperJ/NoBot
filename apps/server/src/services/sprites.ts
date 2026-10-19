import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { removeSpriteBackground, spriteNameFromPath } from '@nobot/core/stage'
import { type SpriteDTO, type SpriteImportResult, updateSpriteInput } from '@nobot/shared'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import sharp, { type Metadata } from 'sharp'
import { db, newId } from '../db/client'
import { characters, sprites } from '../db/schema'
import { paths } from '../env'
import { HttpError, notFound } from '../errors'
import { t } from '../i18n'
import { readZip } from '../lib/zip'

type SpriteRow = typeof sprites.$inferSelect
export function requireCharacter(id: string) {
  // 回收站里的角色当作不存在
  const row = db
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, id), isNull(characters.deletedAt)))
    .get()
  if (!row) throw notFound(t('角色'))
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
  if (bytes.length > 20 * 1024 * 1024) throw new HttpError(400, 'TOO_LARGE', t('单张立绘不能超过 20 MB'))
  let metadata: Metadata
  let thumbnail: Buffer
  try {
    metadata = await sharp(bytes).metadata()
    if (!['png', 'webp', 'gif', 'jpeg'].includes(metadata.format ?? '') || !metadata.width || !metadata.height)
      throw new Error(t('不是支持的图片'))
    thumbnail = await sharp(bytes).resize({ height: 256 }).webp().toBuffer()
  } catch {
    throw new HttpError(400, 'BAD_IMAGE', t('不是图片或不支持的图片格式'))
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
/**
 * 批量导入立绘。overrides 是界面上明确指定的服装 / 表情（单个格子上传）；
 * rootOutfit 是立绘包根目录下的图片归入的服装（界面上当前选中的那套），包里的子目录仍各自成为一套服装
 */
export async function importSprites(
  characterId: string,
  entries: { path: string; data: Uint8Array }[],
  overrides?: { outfit?: string; expression?: string },
  rootOutfit = '',
): Promise<SpriteImportResult> {
  requireCharacter(characterId)
  const result: SpriteImportResult = { added: [], skipped: [] }
  for (const entry of entries) {
    const name = spriteNameFromPath(overrides ? entry.path.split(/[\\/]/).at(-1)! : entry.path)
    if (!overrides && !/\.(png|webp|gif|jpe?g)$/i.test(entry.path)) {
      result.skipped.push(t('{path}：不是图片', { path: entry.path }))
      continue
    }
    const expression = overrides?.expression ?? name?.expression
    if (!expression) {
      result.skipped.push(t('{path}：无法从文件名判断表情，请在对应格子里上传', { path: entry.path }))
      continue
    }
    try {
      result.added.push(
        await saveSprite(characterId, entry.data, overrides?.outfit ?? (name?.outfit || rootOutfit), expression),
      )
    } catch (error) {
      result.skipped.push(
        t('{path}：{error}', { path: entry.path, error: error instanceof Error ? error.message : t('导入失败') }),
      )
    }
  }
  return result
}
export const importSpriteZip = (id: string, bytes: Uint8Array, rootOutfit = '') =>
  importSprites(id, readZip(bytes), undefined, rootOutfit)
function findSprite(characterId: string, id: string) {
  requireCharacter(characterId)
  const row = db
    .select()
    .from(sprites)
    .where(and(eq(sprites.id, id), eq(sprites.characterId, characterId)))
    .get()
  if (!row) throw notFound(t('立绘'))
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
/** 多选删除：只删属于这个角色的立绘，不存在的 id 忽略（可能已经被别处删掉了） */
export async function deleteSprites(characterId: string, ids: string[]) {
  requireCharacter(characterId)
  const rows = db
    .select()
    .from(sprites)
    .where(and(eq(sprites.characterId, characterId), inArray(sprites.id, ids)))
    .all()
  for (const row of rows) await deleteSprite(characterId, row.id)
  return { deleted: rows.length }
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

/** 解码和编码留在服务层，背景判定和羽化由 core 的纯函数负责。 */
export async function transparentSprite(bytes: Uint8Array): Promise<Uint8Array> {
  const { data, info } = await sharp(bytes).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return sharp(removeSpriteBackground(data, info.width, info.height), {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer()
}
