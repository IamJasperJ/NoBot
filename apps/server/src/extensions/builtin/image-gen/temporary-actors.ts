import { regenerateTemporaryActorInput, removeTemporaryActorInput, type TemporaryActorDTO } from '@nobot/shared'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { readUpload } from '../../../lib/files'
import { saveAttachment } from '../../../services/attachments'
import { getChatRow } from '../../../services/chats'
import { cutoutSprite, mattingOptions } from '../../../services/matting'
import { readTemporaryActors, writeTemporaryActor } from '../../../services/temporary-actors'
import { type Context, stageImage } from './pipeline'
import { parseSettings } from './settings'

export const actorTasks = new Set<string>()
export const actorTaskKey = (chatId: string, key: string) => JSON.stringify([chatId, key])

function assertIdle(chatId: string, key: string) {
  if (actorTasks.has(actorTaskKey(chatId, key))) throw new HttpError(409, 'ACTOR_BUSY', t('该临时演员正在生成立绘'))
}

/** 自动与手动生成共用外貌推断、固定构图和去背景流程。 */
export function startTemporaryActor(ctx: Context, chatId: string, key: string, name: string, prompt = '') {
  getChatRow(chatId)
  assertIdle(chatId, key)
  const lock = actorTaskKey(chatId, key)
  actorTasks.add(lock)
  // 重新生成期间和失败后保留旧图，舞台不会突然变成剪影；用户删掉的图不再恢复
  const previous = readTemporaryActors(chatId)[key]
  const image = previous?.status === 'removed' ? null : (previous?.image ?? null)
  const record: TemporaryActorDTO = { key, name, image, prompt, status: 'pending', updatedAt: Date.now() }
  try {
    writeTemporaryActor(chatId, key, record)
  } catch (error) {
    actorTasks.delete(lock)
    throw error
  }
  const task = (async () => {
    try {
      const appearance =
        prompt ||
        (await ctx.host.quietPrompt({
          chatId,
          instruction: `Describe the visible appearance of ${name} for a character sprite. Use the conversation to infer appearance. Output only an English image description, without framing or background instructions.`,
          includeHistory: true,
        }))
      const settings = parseSettings(ctx.settings)
      const backdrop = settings.spriteMatting === 'algorithm' ? settings.spriteBackdrop : 'white'
      const background =
        backdrop === 'green'
          ? "plain solid chroma-key green (#00FF00) background, no green in the character's clothing or lighting"
          : 'simple white background'
      const bytes = await stageImage(
        ctx,
        chatId,
        `${appearance}. Full body, standing, neutral expression, ${background}, no other characters.`,
        'free',
        undefined,
        false,
        settings.spriteMatting === 'native',
      )
      const image = await ctx.host.saveImage(await cutoutSprite(bytes, mattingOptions(parseSettings(ctx.settings))))
      writeTemporaryActor(chatId, key, { ...record, image, prompt: appearance, status: 'done', updatedAt: Date.now() })
      return true
    } catch (error) {
      writeTemporaryActor(chatId, key, {
        ...record,
        status: 'error',
        error: t('临时立绘生成失败，请重试'),
        updatedAt: Date.now(),
      })
      ctx.host.log({ chatId, kind: 'image', status: 'error', summary: String(error) })
      return false
    } finally {
      actorTasks.delete(lock)
    }
  })()
  return { record, task }
}

export function temporaryActorRoutes(app: Hono, ctx: Context) {
  app.get('/temporary-actors', (c) => {
    const chatId = z.string().min(1).parse(c.req.query('chatId'))
    getChatRow(chatId)
    return c.json(Object.values(readTemporaryActors(chatId)).sort((a, b) => b.updatedAt - a.updatedAt))
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
        const image = await saveAttachment(processed)
        const record: TemporaryActorDTO = {
          key,
          name: readTemporaryActors(chatId)[key]?.name ?? key,
          image,
          prompt: '',
          status: 'done',
          updatedAt: Date.now(),
        }
        writeTemporaryActor(chatId, key, record)
        return c.json(record)
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
    writeTemporaryActor(
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
