import { join } from 'node:path'
import type { AttachmentDTO, BackgroundDTO, ImageGenMeta, MessageDTO } from '@nobot/shared'
import { paths } from '../../../../env'
import { HttpError } from '../../../../errors'
import { t } from '../../../../i18n'
import { getAttachment, removeAttachmentFiles } from '../../../../services/attachments'
import { removeUnusedBackground } from '../../../../services/backgrounds/backgrounds'
import { deleteMessage, getChatRow, loadMessage, loadPath } from '../../../../services/chats'
import { currentUser } from '../../../../user-context'
import { notifyChatChanged } from '../../../registry'
import { backendDimensions } from '../backends'
import { resolveImageConnection } from '../discovery'
import { parseSettings, type Settings } from '../settings'
import {
  applyGeneratedBackground,
  discardCancelledBackground,
  isBackgroundTargetBranch,
  isCurrentBackgroundScene,
  saveGeneratedBackground,
} from './background'
import { errorText, freeze, type Snapshot, validate, writePrompt } from './prompt'
import { renderImage } from './render'
import { imageTaskSignal, previews, retryLocks, tasks } from './state'
import type { Context, GenerateInput } from './types'

async function whenChatIdle<T>(ctx: Context, chatId: string, signal: AbortSignal, write: () => T): Promise<T> {
  const deadline = Date.now() + 600000
  do {
    if (Date.now() >= deadline) throw new Error(t('等待文本生成结束超时，请稍后再试'))
    await ctx.host.waitIdle(chatId, deadline - Date.now(), signal)
    signal.throwIfAborted()
  } while (ctx.host.isGenerating(chatId))
  return write()
}
export function caption(snapshot: Snapshot) {
  const values = {
    char: snapshot.prepared.character.name,
    user: snapshot.prepared.info.persona.name,
    prompt: snapshot.rawPrompt ?? snapshot.prompt ?? '',
  }
  return snapshot.settings.messageTemplate.replace(
    /{{(char|user|prompt)}}/g,
    (_, key: keyof typeof values) => values[key],
  )
}
export function cancel(ctx: Context, messageId: string) {
  // 必须先查当前用户的消息，再操作共享任务表，避免猜到 id 就能取消别人的任务。
  const message = loadMessage(messageId)
  const controller = tasks.get(messageId)
  if (!controller) throw new HttpError(400, 'IMAGE_TASK', t('没有可取消的图片任务'))
  controller.abort(new Error(t('已取消')))
  return {
    message: ctx.host.updateMessageMeta(messageId, {
      imageGen: { ...message.meta.imageGen!, status: 'error', error: t('已取消') },
      imageIndex: message.meta.images?.length ?? 0,
    }),
  }
}
export async function generate(ctx: Context, input: GenerateInput) {
  const controller = new AbortController()
  const signal = imageTaskSignal(controller.signal)
  let snapshot: Snapshot
  if (input.snapshotId) {
    const preview = previews.get(`${currentUser().handle}:${input.snapshotId}`)
    if (
      !preview ||
      preview.expires < Date.now() ||
      preview.snapshot.input.chatId !== input.chatId ||
      preview.snapshot.input.mode !== input.mode
    )
      throw new HttpError(400, 'IMAGE_PREVIEW', t('提示词预览已过期，请重新生成预览'))
    snapshot = structuredClone(preview.snapshot)
    previews.delete(`${currentUser().handle}:${input.snapshotId}`)
  } else snapshot = await freeze(ctx, input)
  signal.throwIfAborted()
  const { settings, prepared } = snapshot
  if (input.prompt !== undefined) {
    snapshot.prompt = input.prompt
    snapshot.negative = input.negative ?? snapshot.negative ?? ''
    snapshot.rawPrompt ??= input.prompt
  }
  const meta: ImageGenMeta = {
    status: 'pending',
    stage: input.prompt === undefined ? 'prompt' : 'queued',
    mode: input.mode,
    width: snapshot.width,
    height: snapshot.height,
    seed: settings.seed,
    hidden: !(input.origin === 'interactive' ? settings.visibleFromInteractive : settings.visibleFromButton),
  }
  let pending: MessageDTO | undefined
  const pendingReady =
    settings.async && input.mode !== 'background'
      ? whenChatIdle(ctx, input.chatId, signal, () =>
          ctx.host.appendMessage(input.chatId, {
            role: 'assistant',
            content: '',
            speakerId: prepared.character.id,
            meta: { name: prepared.character.name, imageGen: { ...meta } },
          }),
        ).then((message) => {
          pending = message
          tasks.set(message.id, controller)
          ctx.host.updateMessageMeta(message.id, { imageGen: { ...meta } })
          return message
        })
      : Promise.resolve(undefined)
  const stage = (value: ImageGenMeta['stage'], position?: number) => {
    signal.throwIfAborted()
    meta.stage = value
    meta.queuePosition = position
    if (pending) ctx.host.updateMessageMeta(pending.id, { imageGen: { ...meta } })
  }
  const run = async () => {
    let generatedBackground: BackgroundDTO | undefined
    let keepBackground = false
    let backgroundApplied = false
    try {
      if (snapshot.prompt === undefined) await writePrompt(ctx, snapshot, signal)
      signal.throwIfAborted()
      meta.prompt = snapshot.prompt
      meta.negative = snapshot.negative
      meta.caption = caption(snapshot)
      settings.negativePrompt = snapshot.negative ?? ''
      const bytes = await renderImage(
        ctx,
        settings,
        snapshot.prompt!,
        snapshot.width,
        snapshot.height,
        input.chatId,
        signal,
        stage,
      )
      stage('saving')
      if (input.mode === 'background') {
        signal.throwIfAborted()
        generatedBackground = await saveGeneratedBackground(
          ctx,
          input.chatId,
          bytes,
          prepared.character.name,
          settings,
          snapshot.prompt!,
          input.backgroundName,
          signal,
        )
      }
      await pendingReady
      signal.throwIfAborted()
      const target = prepared.info.chat
      const automatic = input.backgroundName ? generatedBackground : undefined
      const manual = input.backgroundName ? undefined : generatedBackground
      const sourceId = input.historyLeafId ?? target.activeLeafId
      const canAppend = () =>
        automatic
          ? isCurrentBackgroundScene(input.chatId, sourceId, automatic)
          : !manual || isBackgroundTargetBranch(target)
      if (generatedBackground && !canAppend()) {
        notifyChatChanged(input.chatId)
        keepBackground = true
        return { background: generatedBackground, backgroundApplied }
      }
      const image = await ctx.host.saveImage(bytes)
      let message: MessageDTO | undefined
      try {
        signal.throwIfAborted()
        const final = {
          name: prepared.character.name,
          images: [image],
          imageIndex: 0,
          imageGen: { ...meta, status: 'done' as const },
        }
        message = pending
          ? ctx.host.updateMessageMeta(pending.id, final)
          : await whenChatIdle(ctx, input.chatId, signal, () => {
              if (!canAppend()) return
              const added = ctx.host.appendMessage(input.chatId, {
                role: 'assistant',
                content: '',
                speakerId: prepared.character.id,
                meta: final,
              })
              if (manual) backgroundApplied = applyGeneratedBackground(ctx, target, manual.id)
              return added
            })
      } finally {
        if (!message) await removeAttachmentFiles(image.id).catch(console.error)
      }
      if (!message && generatedBackground) notifyChatChanged(input.chatId)
      if (message) ctx.storage.set(`request:${message.id}`, snapshot)
      keepBackground = true
      return { message, ...(generatedBackground ? { background: generatedBackground, backgroundApplied } : {}) }
    } catch (error) {
      await pendingReady
      if (!pending) {
        signal.throwIfAborted()
        throw error
      }
      if (tasks.get(pending.id) !== controller || !loadPath(pending.id, 1).length) return { message: pending }
      return {
        message: ctx.host.updateMessageMeta(pending.id, {
          imageGen: { ...meta, status: 'error', error: signal.aborted ? t('已取消') : errorText(error) },
          imageIndex: 0,
        }),
      }
    } finally {
      if (!keepBackground) await discardCancelledBackground(generatedBackground, signal)
      if (pending && tasks.get(pending.id) === controller) {
        tasks.delete(pending.id)
        if (loadPath(pending.id, 1).length) ctx.storage.set(`request:${pending.id}`, snapshot)
      }
    }
  }
  if (settings.async && input.mode !== 'background') {
    // 提炼和图片请求与文字回复并行，只让消息入库等待文字生成空闲。
    const running = run()
    void running.catch(console.error)
    const message = await pendingReady
    return { message: message! }
  }
  return await run()
}
export function dismiss(ctx: Context, messageId: string) {
  const message = loadMessage(messageId)
  if (message.meta.imageGen?.status !== 'error')
    throw new HttpError(409, 'IMAGE_DISMISS', t('只能放弃失败或已取消的图片任务'))
  // 取消后的异步请求可能还在收尾，撤销任务所有权，避免它重新写回已放弃的框。
  tasks.delete(messageId)
  if (!message.meta.images?.length) {
    deleteMessage(messageId)
    ctx.storage.delete(`request:${messageId}`)
    return { deleted: true }
  }
  return {
    message: ctx.host.updateMessageMeta(messageId, {
      imageIndex: message.meta.images.length - 1,
      imageGen: { ...message.meta.imageGen, status: 'done', error: undefined },
    }),
  }
}
export async function retry(
  ctx: Context,
  messageId: string,
  append = true,
  edited: { prompt?: string; negative?: string } = {},
) {
  const message = loadMessage(messageId)
  const old = message.meta.imageGen
  if (tasks.has(messageId) || retryLocks.has(messageId) || old?.status === 'pending')
    throw new HttpError(409, 'IMAGE_BUSY', t('这张图片正在重新生成'))
  if (!old) throw new HttpError(400, 'IMAGE_RETRY', t('这条消息没有可重试的图片任务'))
  const backgroundTarget = old.mode === 'background' ? getChatRow(message.chatId) : undefined
  retryLocks.add(messageId)
  const controller = new AbortController()
  const signal = imageTaskSignal(controller.signal)
  tasks.set(messageId, controller)
  let snapshot = ctx.storage.get<Snapshot>(`request:${messageId}`)
  // 重试 / 重新生成用「当前」的接口设置（后端、模型、地址、密钥、请求头、工作流、采样参数……）：
  // 失败往往正是因为设置不对，用户改好设置后再点重试必须生效。
  // 和这张图本身相关的内容沿用原任务：提示词、负面提示词、画幅比例、冻结的头像数据
  let settings: Settings
  try {
    settings = structuredClone(resolveImageConnection(parseSettings(ctx.settings), false))
    validate(settings)
  } catch (error) {
    retryLocks.delete(messageId)
    tasks.delete(messageId)
    throw error
  }
  if (snapshot) {
    const frozen = snapshot.settings as Settings & { charAvatar?: unknown; userAvatar?: unknown }
    Object.assign(settings, {
      ...(frozen.charAvatar === undefined ? {} : { charAvatar: frozen.charAvatar }),
      ...(frozen.userAvatar === undefined ? {} : { userAvatar: frozen.userAvatar }),
    })
  }
  settings.seed = Math.floor(Math.random() * 2 ** 48)
  let size = { width: old.width ?? settings.width, height: old.height ?? settings.height }
  // 换了 OpenAI 模型时，尺寸要按新模型支持的规格重新贴合（比如 gpt-image 只接受 1024 / 1536）
  size = backendDimensions(settings, size.width, size.height)
  let meta: ImageGenMeta = {
    ...old,
    ...size,
    status: 'pending',
    stage: (edited.prompt ?? old.prompt) ? 'queued' : 'prompt',
    prompt: edited.prompt ?? old.prompt,
    negative: edited.negative ?? old.negative,
    seed: settings.seed,
    error: undefined,
  }
  const pending = ctx.host.updateMessageMeta(messageId, {
    imageGen: meta,
    imageIndex: message.meta.images?.length ?? 0,
  })
  const run = async () => {
    let image: AttachmentDTO | undefined
    let generatedBackground: BackgroundDTO | undefined
    let committed = false
    try {
      let prompt = meta.prompt
      if (!prompt) {
        if (!snapshot) throw new Error(t('缺少原始生成描述，请重新发起图片生成'))
        snapshot = await writePrompt(ctx, { ...snapshot, settings }, signal)
        prompt = snapshot.prompt
      }
      meta = {
        ...meta,
        prompt,
        negative: edited.negative ?? old.negative ?? snapshot?.negative,
        caption:
          edited.prompt !== undefined && snapshot
            ? caption({ ...snapshot, rawPrompt: edited.prompt, prompt: edited.prompt })
            : (old.caption ?? (snapshot ? caption(snapshot) : undefined)),
      }
      settings.negativePrompt = meta.negative ?? ''
      const stage = (value: ImageGenMeta['stage'], position?: number) => {
        signal.throwIfAborted()
        meta.stage = value
        meta.queuePosition = position
        ctx.host.updateMessageMeta(messageId, { imageGen: { ...meta } })
      }
      const bytes = await renderImage(ctx, settings, prompt!, size.width, size.height, message.chatId, signal, stage)
      stage('saving')
      if (backgroundTarget) {
        generatedBackground = await saveGeneratedBackground(
          ctx,
          message.chatId,
          bytes,
          message.meta.name ?? '',
          settings,
          prompt!,
          snapshot?.input.backgroundName,
          signal,
        )
      }
      image = await ctx.host.saveImage(bytes)
      signal.throwIfAborted()
      const images = append ? [...(loadMessage(messageId).meta.images ?? []), image] : [image]
      const updated = ctx.host.updateMessageMeta(messageId, {
        images,
        imageIndex: images.length - 1,
        imageGen: { ...meta, status: 'done' },
      })
      committed = true
      if (generatedBackground && backgroundTarget && !snapshot?.input.backgroundName)
        applyGeneratedBackground(ctx, backgroundTarget, generatedBackground.id)
      return { message: updated }
    } catch (error) {
      if (tasks.get(messageId) !== controller) return { message: pending }
      const current = loadPath(messageId, 1)[0]
      if (!current) throw error
      const result = {
        message: ctx.host.updateMessageMeta(messageId, {
          imageGen: { ...meta, status: 'error', error: signal.aborted ? t('已取消') : errorText(error) },
          imageIndex: current.meta.images?.length ?? 0,
        }),
      }
      return result
    } finally {
      if (!committed) {
        if (image) await removeAttachmentFiles(image.id).catch(console.error)
        await discardCancelledBackground(generatedBackground, signal)
      }
      retryLocks.delete(messageId)
      if (tasks.get(messageId) === controller) tasks.delete(messageId)
    }
  }
  if (settings.async) {
    void run().catch(console.error)
    return { message: pending }
  }
  return await run()
}
export async function toBackground(ctx: Context, messageId: string, index: number, chatId?: string) {
  const signal = imageTaskSignal()
  const message = loadMessage(messageId)
  const image = message.meta.images?.[index]
  if (!image) throw new HttpError(400, 'IMAGE_MISSING', t('这条消息没有指定的图片'))
  const target = getChatRow(chatId ?? message.chatId)
  getAttachment(image.id)
  const background = await saveGeneratedBackground(
    ctx,
    target.id,
    new Uint8Array(await Bun.file(join(paths.attachments, `${image.id}.webp`)).arrayBuffer()),
    message.meta.name ?? t('图片'),
    resolveImageConnection(parseSettings(ctx.settings), false),
    message.meta.imageGen?.prompt ?? '',
    undefined,
    signal,
  )
  try {
    signal.throwIfAborted()
    if (!applyGeneratedBackground(ctx, target, background.id)) {
      await removeUnusedBackground(background.id).catch(console.error)
      throw new HttpError(409, 'BACKGROUND_CONTEXT_CHANGED', t('会话分支或背景已变化，请重新选择背景'))
    }
    return { background }
  } finally {
    await discardCancelledBackground(background, signal)
  }
}
