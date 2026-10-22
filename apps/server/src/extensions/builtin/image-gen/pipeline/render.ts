import type { ImageGenMeta } from '@nobot/shared'
import { t } from '../../../../i18n'
import { currentUser } from '../../../../user-context'
import { getBackend } from '../backends'
import { dimensions } from '../composition'
import { resolveImageConnection } from '../discovery'
import { Semaphore } from '../semaphore'
import { parseSettings, type Settings } from '../settings'
import { safeError, safeSnapshot, validate } from './prompt'
import { imageQueues } from './state'
import type { Context } from './types'

export async function renderImage(
  ctx: Context,
  settings: Settings,
  prompt: string,
  width: number,
  height: number,
  chatId?: string,
  signal?: AbortSignal,
  stage?: (stage: ImageGenMeta['stage'], position?: number) => void,
  referenceImage?: string,
  transparent?: boolean,
) {
  const started = Date.now()
  const request = {
    ...safeSnapshot(settings),
    prompt,
    width,
    height,
    ...(referenceImage ? { referenceImage: true } : {}),
  }
  try {
    validate(settings)
    const handle = currentUser().handle
    let imageQueue = imageQueues.get(handle)
    if (!imageQueue) {
      imageQueue = new Semaphore(settings.maxConcurrent)
      imageQueues.set(handle, imageQueue)
    }
    imageQueue.setLimit(settings.maxConcurrent)
    const bytes = await imageQueue.run(
      async () => {
        stage?.('generating')
        const result = await getBackend(settings).generate(
          { settings, prompt, width, height, referenceImage, transparent },
          signal,
        )
        if (result.seed !== undefined) settings.seed = result.seed
        return result.bytes
      },
      signal,
      (position) => stage?.('queued', position),
    )
    signal?.throwIfAborted()
    ctx.host.log({
      chatId,
      kind: 'image',
      status: 'ok',
      model: getBackend(settings).model(settings),
      durationMs: Date.now() - started,
      summary: t('{source}：{prompt}', { source: settings.source, prompt: prompt.slice(0, 60) }),
      request,
      response: { byteLength: bytes.length },
    })
    return bytes
  } catch (error) {
    ctx.host.log({
      chatId,
      kind: 'image',
      status: 'error',
      durationMs: Date.now() - started,
      summary: t('{source}：{prompt}', { source: settings.source, prompt: prompt.slice(0, 60) }),
      request,
      response: {
        error: signal?.aborted ? t('已取消') : safeError(error, settings),
      },
    })
    throw error
  }
}
export async function testImage(ctx: Context) {
  const settings = resolveImageConnection(parseSettings(ctx.settings), false)
  const started = Date.now()
  const size = dimensions(settings)
  const bytes = await renderImage(
    ctx,
    settings,
    'a cute cat sitting on a windowsill, sunlight',
    size.width,
    size.height,
  )
  return { image: await ctx.host.saveImage(bytes), durationMs: Date.now() - started }
}
