import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type CutoutMode, type SpriteJobDTO, spriteCutoutInput } from '@nobot/shared'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { db, newId } from '../../db/client'
import { sprites } from '../../db/schema'
import { paths } from '../../env'
import { HttpError, notFound } from '../../errors'
import { t } from '../../i18n'
import { cutoutSprite, mattingService } from './matting'
import { findSprite, requireCharacter, spriteOriginalPath } from './sprites'

const jobs = new Map<string, { characterId: string; progress: SpriteJobDTO }>()
const running = new Set<string>()

export async function assertCutoutMode(mode: CutoutMode) {
  if (mode !== 'model') return
  const status = await mattingService.status()
  if (status.runtime.state !== 'ready' || status.model.state !== 'ready')
    throw new HttpError(400, 'MATTING_NOT_READY', t('本地抠图模型还没下载，请先在图片生成设置里下载'))
}

export function recutImage(bytes: Uint8Array, mode: CutoutMode, force: boolean) {
  return cutoutSprite(bytes, { mode, backdrop: 'white', modelUrl: '', registry: '' }, { force, strict: true })
}

export async function previewSpriteCutout(characterId: string, id: string, mode: CutoutMode) {
  const row = findSprite(characterId, id)
  await assertCutoutMode(mode)
  const original = spriteOriginalPath(row)
  const bytes = new Uint8Array(
    await Bun.file(original ?? join(paths.sprites, characterId, `${id}.${row.ext}`)).arrayBuffer(),
  )
  return recutImage(bytes, mode, !original)
}

async function applySpriteCutout(characterId: string, id: string, mode: CutoutMode) {
  const row = findSprite(characterId, id)
  const directory = join(paths.sprites, characterId)
  const current = join(directory, `${id}.${row.ext}`)
  const original = spriteOriginalPath(row)
  const bytes = new Uint8Array(await Bun.file(original ?? current).arrayBuffer())
  const result = await recutImage(bytes, mode, !original)
  const metadata = await sharp(result).metadata()
  const thumbnail = await sharp(result).resize({ height: 256 }).webp().toBuffer()
  // 处理期间可能被删除，避免重新制造已删除立绘的文件。
  findSprite(characterId, id)
  if (!original) await Bun.write(join(directory, `${id}.orig.${row.ext}`), bytes)
  await Bun.write(join(directory, `${id}.png`), result)
  await Bun.write(join(directory, `${id}.thumb.webp`), thumbnail)
  db.update(sprites)
    .set({
      ext: 'png',
      width: metadata.width!,
      height: metadata.height!,
      updatedAt: Math.max(Date.now(), row.updatedAt + 1, row.createdAt + 1),
    })
    .where(eq(sprites.id, id))
    .run()
  if (row.ext !== 'png') await rm(current, { force: true })
}

export async function startSpriteCutout(characterId: string, input: unknown) {
  requireCharacter(characterId)
  const { ids, mode } = spriteCutoutInput.parse(input)
  await assertCutoutMode(mode)
  if (running.has(characterId)) throw new HttpError(409, 'SPRITE_BUSY', t('该角色正在重新抠图'))
  const unique = [...new Set(ids)]
  for (const id of unique) findSprite(characterId, id)
  running.add(characterId)
  const jobId = newId()
  const progress: SpriteJobDTO = { total: unique.length, done: 0, failed: 0, status: 'running' }
  if (jobs.size >= 200) {
    for (const [id, job] of jobs) {
      if (job.progress.status === 'done' || job.progress.status === 'error') {
        jobs.delete(id)
        break
      }
    }
  }
  jobs.set(jobId, { characterId, progress })
  void (async () => {
    try {
      for (const id of unique) {
        try {
          await applySpriteCutout(characterId, id, mode)
          progress.done++
        } catch {
          progress.failed++
        }
      }
      progress.status = progress.failed ? 'error' : 'done'
    } finally {
      running.delete(characterId)
    }
  })()
  return { jobId, ...progress }
}

export function spriteCutoutJob(characterId: string, jobId: string): SpriteJobDTO {
  requireCharacter(characterId)
  const job = jobs.get(jobId)
  if (!job || job.characterId !== characterId) throw notFound(t('立绘生成任务'))
  return { ...job.progress }
}
