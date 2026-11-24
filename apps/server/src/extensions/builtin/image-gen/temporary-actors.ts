import { join } from 'node:path'
import {
  type AttachmentDTO,
  regenerateTemporaryActorInput,
  removeTemporaryActorInput,
  type TemporaryActorDTO,
  temporaryActorCutoutInput,
} from '@nobot/shared'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { paths } from '../../../env'
import { HttpError, notFound } from '../../../errors'
import { t } from '../../../i18n'
import { readUpload } from '../../../lib/files'
import { validate } from '../../../lib/validate'
import { removeAttachmentFiles, saveAttachment } from '../../../services/attachments'
import { getChatRow } from '../../../services/chats'
import { cutoutSprite, mattingOptions } from '../../../services/sprites/matting'
import { assertCutoutMode, recutImage } from '../../../services/sprites/sprite-cutout'
import {
  readTemporaryActors,
  type TemporaryActorRecord,
  writeTemporaryActor as writeActor,
} from '../../../services/sprites/temporary-actors'
import { type Context, stageImage } from './pipeline'
import { imageTaskSignal } from './pipeline/state'
import { parseSettings } from './settings'

function actorDTO(record: TemporaryActorRecord): TemporaryActorDTO {
  const { original, ...dto } = record
  return { ...dto, hasOriginal: !!original }
}
async function cleanAttachments(...images: (AttachmentDTO | null | undefined)[]) {
  for (const image of images) {
    if (!image) continue
    await removeAttachmentFiles(image.id).catch((error) => console.error('删除临时立绘失败', image.id, error))
  }
}
function writeTemporaryActor(chatId: string, key: string, record: TemporaryActorRecord | null) {
  writeActor(chatId, key, record ? { ...record, hasOriginal: !!record.original } : null)
}
async function replaceActor(chatId: string, key: string, record: TemporaryActorRecord | null) {
  const old = readTemporaryActors(chatId)[key]
  writeTemporaryActor(chatId, key, record)
  const retained = new Set([record?.image?.id, record?.original?.id])
  await cleanAttachments(...[old?.image, old?.original].filter((image) => image && !retained.has(image.id)))
}

export const actorTasks = new Set<string>()
export const actorTaskKey = (chatId: string, key: string) => JSON.stringify([chatId, key])

function assertIdle(chatId: string, key: string) {
  if (actorTasks.has(actorTaskKey(chatId, key))) throw new HttpError(409, 'ACTOR_BUSY', t('该临时演员正在生成立绘'))
}

/** 自动与手动生成共用外貌推断、固定构图和去背景流程。 */
export function startTemporaryActor(ctx: Context, chatId: string, key: string, name: string, prompt = '') {
  const signal = imageTaskSignal()
  signal.throwIfAborted()
  getChatRow(chatId)
  assertIdle(chatId, key)
  const lock = actorTaskKey(chatId, key)
  actorTasks.add(lock)
  // 重新生成期间和失败后保留旧图，舞台不会突然变成剪影；用户删掉的图不再恢复
  const previous = readTemporaryActors(chatId)[key]
  const image = previous?.status === 'removed' ? null : (previous?.image ?? null)
  const record: TemporaryActorRecord = {
    key,
    name,
    image,
    original: previous?.original,
    prompt,
    status: 'pending',
    updatedAt: Date.now(),
  }
  try {
    writeTemporaryActor(chatId, key, record)
  } catch (error) {
    actorTasks.delete(lock)
    throw error
  }
  const stillPending = () => {
    const current = readTemporaryActors(chatId)[key]
    return current?.status === 'pending' && current.updatedAt === record.updatedAt
  }
  const task = (async () => {
    let newImage: AttachmentDTO | undefined
    let newOriginal: AttachmentDTO | undefined
    let committed = false
    try {
      const appearance =
        prompt ||
        (await ctx.host.quietPrompt({
          chatId,
          instruction: `Describe the visible appearance of ${name} for a character sprite. Use the conversation to infer appearance. Output only an English image description, without framing or background instructions.`,
          includeHistory: true,
          signal,
        }))
      const settings = parseSettings(ctx.settings)
      const backdrop = settings.spriteMatting === 'algorithm' ? settings.spriteBackdrop : 'white'
      const background =
        backdrop === 'green'
          ? "plain solid chroma-key green (#00FF00) background, no green in the character's clothing or lighting"
          : 'simple white background'
      const bytes = await stageImage(ctx, {
        chatId,
        prompt: `${appearance}. Full body, standing, neutral expression, ${background}, no other characters.`,
        mode: 'free',
        landscape: false,
        transparent: settings.spriteMatting === 'native',
        signal,
      })
      const cutout = await cutoutSprite(bytes, mattingOptions(parseSettings(ctx.settings)))
      signal.throwIfAborted()
      if (!stillPending()) return false
      newImage = await ctx.host.saveImage(cutout)
      signal.throwIfAborted()
      if (!stillPending()) return false
      newOriginal = await ctx.host.saveImage(bytes)
      signal.throwIfAborted()
      if (!stillPending()) return false
      await replaceActor(chatId, key, {
        ...record,
        image: newImage,
        original: newOriginal,
        prompt: appearance,
        status: 'done',
        updatedAt: Date.now(),
      })
      committed = true
      return true
    } catch (error) {
      if (!stillPending()) return false
      writeTemporaryActor(chatId, key, {
        ...record,
        status: 'error',
        error: signal.aborted ? t('已取消') : t('临时立绘生成失败，请重试'),
        updatedAt: Date.now(),
      })
      ctx.host.log({ chatId, kind: 'image', status: 'error', summary: String(error) })
      return false
    } finally {
      if (!committed) await cleanAttachments(newImage, newOriginal)
      actorTasks.delete(lock)
    }
  })()
  return { record: actorDTO(record), task }
}

export function temporaryActorRoutes(app: Hono, ctx: Context) {
  app.get('/temporary-actors', (c) => {
    const chatId = z.string().min(1).parse(c.req.query('chatId'))
    getChatRow(chatId)
    return c.json(
      Object.values(readTemporaryActors(chatId))
        .map(actorDTO)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    )
  })
  app.post('/temporary-actors/cutout', validate('json', temporaryActorCutoutInput), async (c) => {
    const { chatId, key, mode, preview } = c.req.valid('json')
    getChatRow(chatId)
    assertIdle(chatId, key)
    const record = readTemporaryActors(chatId)[key]
    if (!record?.image) throw notFound(t('立绘'))
    const lock = actorTaskKey(chatId, key)
    // 预览只检查生成任务，不占锁，允许开发模式重复 effect 并发读取同一原图。
    if (!preview) actorTasks.add(lock)
    let saved: AttachmentDTO | undefined
    try {
      await assertCutoutMode(mode)
      const source = record.original ?? record.image
      const bytes = new Uint8Array(await Bun.file(join(paths.attachments, `${source.id}.webp`)).arrayBuffer())
      const result = await recutImage(bytes, mode, !record.original)
      if (preview)
        return new Response(result, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } })
      // 无原图的旧记录保留当前附件，后续重抠始终使用同一份来源。
      saved = await saveAttachment(result)
      const updated: TemporaryActorRecord = {
        ...record,
        original: record.original ?? record.image,
        image: saved,
        updatedAt: Math.max(Date.now(), record.updatedAt + 1),
      }
      await replaceActor(chatId, key, updated)
      return c.json(actorDTO(updated))
    } catch (error) {
      await cleanAttachments(saved)
      throw error
    } finally {
      if (!preview) actorTasks.delete(lock)
    }
  })
  app.post('/temporary-actors/regenerate', async (c) => {
    const { chatId, key, prompt } = regenerateTemporaryActorInput.parse(await c.req.json())
    const { record, task } = startTemporaryActor(
      ctx,
      chatId,
      key,
      readTemporaryActors(chatId)[key]?.name ?? key,
      prompt,
    )
    void task
    return c.json(record)
  })
  app.post(
    '/temporary-actors/upload',
    bodyLimit({
      maxSize: 11 * 1024 * 1024,
      onError: () => {
        throw new HttpError(400, 'TOO_LARGE', t('文件太大（上限 10MB）'))
      },
    }),
    async (c) => {
      const body = await c.req.parseBody()
      const { chatId, key } = z.object({ chatId: z.string(), key: z.string() }).parse(body)
      getChatRow(chatId)
      assertIdle(chatId, key)
      const lock = actorTaskKey(chatId, key)
      actorTasks.add(lock)
      let image: AttachmentDTO | undefined
      let original: AttachmentDTO | undefined
      try {
        const bytes = await readUpload(body, 'file', 10)
        let processed = bytes
        if (body.removeBackground === 'true') {
          try {
            processed = await cutoutSprite(bytes, mattingOptions(parseSettings(ctx.settings)))
          } catch {
            throw new HttpError(400, 'BAD_IMAGE', t('无法识别的图片文件'))
          }
        }
        image = await saveAttachment(processed)
        if (body.removeBackground === 'true') original = await saveAttachment(bytes)
        const record: TemporaryActorRecord = {
          key,
          name: readTemporaryActors(chatId)[key]?.name ?? key,
          image,
          original,
          prompt: '',
          status: 'done',
          updatedAt: Date.now(),
        }
        await replaceActor(chatId, key, record)
        return c.json(actorDTO(record))
      } catch (error) {
        await cleanAttachments(image, original)
        throw error
      } finally {
        actorTasks.delete(lock)
      }
    },
  )
  app.delete('/temporary-actors', async (c) => {
    const { chatId, key, purge } = removeTemporaryActorInput.parse(await c.req.json())
    getChatRow(chatId)
    assertIdle(chatId, key)
    const old = readTemporaryActors(chatId)[key]
    await replaceActor(
      chatId,
      key,
      purge
        ? null
        : {
            key,
            name: old?.name ?? key,
            image: null,
            prompt: old?.prompt ?? '',
            status: 'removed',
            updatedAt: Date.now(),
          },
    )
    return c.json({ ok: true })
  })
}
