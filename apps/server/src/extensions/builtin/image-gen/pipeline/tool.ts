import type { ImageGenMeta } from '@nobot/shared'
import { t } from '../../../../i18n'
import { editMessage } from '../../../../services/chats'
import type { ToolResult } from '../../../../tools'
import type { ExtensionContext } from '../../../types'
import { backendDimensions } from '../backends'
import { characterPrompt, composePrompt, dimensions } from '../composition'
import type { Mode } from '../modes'
import { background } from './background'
import { caption } from './message'
import { errorText, freeze, safeError, writePrompt } from './prompt'
import { renderImage } from './render'
import { tasks } from './state'

export async function runImageTool(
  ctx: ExtensionContext,
  args: Record<string, unknown>,
  options: { updateToolContent?: boolean; signal?: AbortSignal } = {},
): Promise<ToolResult> {
  let meta: ImageGenMeta = { status: 'error', mode: 'tool' }
  try {
    options.signal?.throwIfAborted()
    const legacy = args.mode === undefined
    const requested =
      args.mode === 'portrait' ? 'face' : (args.mode ?? (args.as_background === true ? 'background' : 'free'))
    if (
      typeof requested !== 'string' ||
      !['free', 'character', 'face', 'user', 'last', 'raw_last', 'scene', 'background'].includes(requested)
    )
      throw new Error(t('图片生成模式无效'))
    const mode = requested as Mode
    if (args.prompt !== undefined && (typeof args.prompt !== 'string' || !args.prompt.trim()))
      throw new Error(t('图片提示词不能为空'))
    if (args.orientation !== undefined && !['portrait', 'landscape', 'square'].includes(String(args.orientation)))
      throw new Error(t('图片方向无效'))
    let characterId: string | undefined
    if (args.character !== undefined) {
      if (typeof args.character !== 'string' || !args.character.trim()) throw new Error(t('会话中没有这个角色'))
      const matches = ctx.host.getChatInfo(ctx.chatId, 0).characters.filter((item) => item.name === args.character)
      if (matches.length !== 1) throw new Error(t('角色名字不存在或不唯一'))
      characterId = matches[0]!.id
    }
    const snapshot = await freeze(ctx, {
      chatId: ctx.chatId,
      mode,
      characterId,
      input: typeof args.prompt === 'string' ? args.prompt : undefined,
      // 显式描述绕过依赖上下文的输入校验，但仍保留所选模式和角色。
      prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
    })
    const { settings, prepared } = snapshot
    const styleMode = legacy ? 'tool' : mode
    let size =
      args.orientation === undefined
        ? { width: snapshot.width, height: snapshot.height }
        : dimensions(settings, args.orientation === 'landscape', styleMode)
    if (args.orientation === 'square') size.height = size.width
    size = backendDimensions(settings, size.width, size.height)
    snapshot.character = characterPrompt(
      mode === 'background' ? 'background' : legacy ? 'tool' : mode,
      prepared.character.extensions,
      !!prepared.info.chat.groupId,
      !!characterId,
    )
    Object.assign(snapshot, size)
    const run = async (messageId?: string): Promise<ToolResult> => {
      const controller = new AbortController()
      const signal =
        !messageId && options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
      if (messageId) {
        tasks.set(messageId, controller)
        ctx.storage.set(`request:${messageId}`, snapshot)
      }
      try {
        const stage = (value: ImageGenMeta['stage'], position?: number) => {
          signal.throwIfAborted()
          meta = { ...meta, stage: value, queuePosition: position }
          if (messageId) ctx.host.updateMessageMeta(messageId, { imageGen: meta })
        }
        if (typeof args.prompt === 'string') {
          let prompt = args.prompt
          if (settings.refineModelPrompts) {
            try {
              // 润色最终描述始终使用自由描述模板，避免角色模板丢弃模型已给出的场景。
              const rewritten = await writePrompt(
                ctx,
                {
                  ...snapshot,
                  input: { ...snapshot.input, mode: legacy && mode === 'background' ? 'background' : 'free' },
                },
                signal,
                true,
              )
              const refined = rewritten.rawPrompt
              if (refined) prompt = refined
            } catch (error) {
              ctx.host.log({
                chatId: ctx.chatId,
                kind: 'image',
                status: 'error',
                summary: t('生图提示词润色失败：{error}', { error: safeError(error, settings) }),
              })
            }
          }
          Object.assign(snapshot, composePrompt(settings, styleMode, prompt, snapshot.character))
        } else await writePrompt(ctx, snapshot, signal)
        settings.negativePrompt = snapshot.negative ?? ''
        meta = { ...meta, prompt: snapshot.prompt, negative: snapshot.negative, caption: caption(snapshot) }
        const bytes = await renderImage(
          ctx,
          settings,
          snapshot.prompt!,
          size.width,
          size.height,
          ctx.chatId,
          signal,
          stage,
        )
        stage('saving')
        if (mode === 'background') {
          await background(
            ctx,
            ctx.chatId,
            bytes,
            prepared.character.name,
            settings,
            snapshot.prompt!,
            undefined,
            signal,
          )
        }
        const image = await ctx.host.saveImage(bytes)
        signal.throwIfAborted()
        const result = {
          content:
            mode === 'background'
              ? 'Image generated and set as the chat background.'
              : 'Image generated and shown to the user.',
          meta: { images: [image], imageIndex: 0, imageGen: { ...meta, status: 'done' as const } },
        }
        if (messageId) ctx.host.updateMessageMeta(messageId, result.meta)
        return result
      } catch (error) {
        ctx.host.log({
          chatId: ctx.chatId,
          kind: 'image',
          status: 'error',
          summary: t('生成图片'),
          response: { messageId, stage: meta.stage, error: safeError(error, settings) },
        })
        const result = {
          content: 'Image generation failed. The user can inspect the error and retry.',
          meta: {
            imageGen: {
              ...meta,
              status: 'error' as const,
              error: signal.aborted ? t('已取消') : safeError(error, settings),
            },
          },
        }
        if (messageId && tasks.get(messageId) === controller) ctx.host.updateMessageMeta(messageId, result.meta)
        return result
      } finally {
        if (messageId && tasks.get(messageId) === controller) {
          tasks.delete(messageId)
          ctx.storage.set(`request:${messageId}`, snapshot)
        }
      }
    }
    meta = {
      status: 'pending',
      stage: args.prompt === undefined || settings.refineModelPrompts ? 'prompt' : 'queued',
      mode: styleMode,
      seed: settings.seed,
      hidden: !settings.visibleFromTool,
      ...size,
    }
    if (!settings.async) return await run()
    let started = false
    const result: ToolResult = {
      content: JSON.stringify({
        status: 'queued',
        message:
          'Continue your reply without waiting. Do not claim the image is finished or invent its URL. The placeholder updates automatically.',
      }),
      meta: { imageGen: meta },
      onSaved(messageId) {
        if (started) return
        started = true
        // 工具消息 id 由宿主在保存时分配；在下一轮模型读取历史之前补入任务编号。
        result.content = JSON.stringify({
          status: 'queued',
          task_id: messageId,
          message:
            'Continue your reply without waiting. Do not claim the image is finished or invent its URL. The placeholder updates automatically.',
        })
        // 斜杠命令保存用户描述；队列 JSON 只用于工具消息，避免把模型指令发给网页用户。
        if (options.updateToolContent !== false) editMessage(messageId, result.content)
        ctx.host.updateMessageMeta(messageId, { imageGen: meta })
        void run(messageId).catch(console.error)
      },
    }
    return result
  } catch (error) {
    return {
      content: 'Image generation failed. The user can inspect the error and retry.',
      meta: { imageGen: { ...meta, status: 'error', error: errorText(error) } },
    }
  }
}
