import { join } from 'node:path'
import type { ImageGenMeta } from '@ai-parter/shared'
import { paths } from '../../../env'
import { HttpError } from '../../../errors'
import { getAttachment } from '../../../services/attachments'
import { deleteMessage, loadMessage } from '../../../services/chats'
import type { ToolResult } from '../../../tools'
import type { ExtensionContext } from '../../types'
import { generateComfy } from './backends/comfy'
import { generateOpenAI } from './backends/openai'
import { characterPrompt, composePrompt, dimensions } from './composition'
import { comfyHeaders, openaiHeaders, resolveImageConnection } from './discovery'
import { cleanPrompt, type Mode, rawPrompt, replaceTemplate, templateEnding, templates } from './modes'
import { fitOpenaiSize } from './options'
import { Semaphore } from './semaphore'
import { parseSettings, type Settings } from './settings'
import { workflowSource } from './workflow'

export { dimensions } from './composition'
export type Context = Omit<ExtensionContext, 'chatId'>
export interface GenerateInput {
  chatId: string
  mode: Mode
  messageId?: string
  input?: string
  characterId?: string
  prompt?: string
  negative?: string
  snapshotId?: string
  origin?: 'button' | 'interactive'
}
const imageQueue = new Semaphore(3)
const tasks = new Map<string, AbortController>()
const retryLocks = new Set<string>()
const previews = new Map<string, { expires: number; snapshot: Snapshot }>()
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
function validate(settings: Settings) {
  if (settings.source === 'openai' && (!settings.openaiBaseUrl.trim() || !settings.openaiModel.trim()))
    throw new HttpError(400, 'IMAGE_CONFIG', '请先配置图片接口地址和模型')
  if (settings.source === 'comfy' && !settings.comfyUrl.trim())
    throw new HttpError(400, 'IMAGE_CONFIG', '请先配置 ComfyUI 地址')
}
async function appendImage(ctx: Context, chatId: string, message: Parameters<Context['host']['appendMessage']>[1]) {
  const deadline = Date.now() + 600000
  do {
    if (Date.now() >= deadline) throw new Error('等待文本生成结束超时，请稍后再试')
    await ctx.host.waitIdle(chatId, deadline - Date.now())
  } while (ctx.host.isGenerating(chatId))
  return ctx.host.appendMessage(chatId, message)
}
function prepare(ctx: Context, input: GenerateInput) {
  const info = ctx.host.getChatInfo(input.chatId, 1000)
  const lastSpeaker = [...info.messages]
    .reverse()
    .find((m) => m.speakerId && info.characters.some((c) => c.id === m.speakerId))?.speakerId
  const character =
    info.characters.find((c) => c.id === (input.characterId ?? lastSpeaker)) ??
    info.characters.find((c) => !c.muted) ??
    info.characters[0]
  if (!character || (input.characterId && !info.characters.some((c) => c.id === input.characterId)))
    throw new HttpError(400, 'IMAGE_CHARACTER', '会话中没有这个角色')
  let text = input.input ?? ''
  if (input.mode === 'message') {
    if (!input.messageId) throw new HttpError(400, 'IMAGE_MESSAGE', '请指定消息')
    const message = loadMessage(input.messageId)
    if (message.chatId !== input.chatId) throw new HttpError(400, 'IMAGE_MESSAGE', '指定消息不属于这个会话')
    text = message.content
  } else if (input.mode === 'last' || input.mode === 'raw_last')
    text = [...info.messages].reverse().find((m) => m.content.trim())?.content ?? ''
  if (input.prompt === undefined && ['free', 'last', 'raw_last', 'message'].includes(input.mode) && !text.trim())
    throw new HttpError(400, 'IMAGE_INPUT', '没有可用于生成图片的描述')
  return { info, character, text }
}
interface Snapshot {
  settings: Settings
  input: GenerateInput
  prepared: ReturnType<typeof prepare>
  width: number
  height: number
  character: { positive?: string; negative?: string }
  prompt?: string
  negative?: string
  rawPrompt?: string
}
async function freeze(ctx: Context, input: GenerateInput): Promise<Snapshot> {
  const settings = structuredClone(resolveImageConnection(parseSettings(ctx.settings)))
  validate(settings)
  const prepared = structuredClone(prepare(ctx, input))
  // 原始描述已提取，不为每张图重复持久化整段聊天历史。
  prepared.info.messages = []
  const orientation = ['scene', 'background'].includes(input.mode)
    ? true
    : ['character', 'face', 'user'].includes(input.mode)
      ? false
      : undefined
  let size = dimensions(settings, orientation, input.mode)
  if (settings.source === 'openai') {
    const [width, height] = fitOpenaiSize(settings, size.width, size.height).split('x').map(Number)
    size = { width: width!, height: height! }
  }
  const character = characterPrompt(input.mode, prepared.character.extensions, !!prepared.info.chat.groupId)
  // 在任何异步工作开始前冻结角色外貌、设置与随机种子。
  settings.seed = settings.seed === -1 ? Math.floor(Math.random() * 2 ** 48) : settings.seed
  settings.comfyCustomPlaceholders = settings.comfyCustomPlaceholders.map((item) => ({
    ...item,
    replace: item.replace.replace(/{{(char|user)}}/g, (_, key) =>
      key === 'char' ? prepared.character.name : prepared.info.persona.name,
    ),
  }))
  const workflow = workflowSource(settings)
  if (settings.source === 'comfy') {
    const sharp = (await import('sharp')).default
    for (const [placeholder, kind, id, key] of [
      ['%char_avatar%', 'character', prepared.character.id, 'charAvatar'],
      ['%user_avatar%', 'persona', prepared.info.persona.id, 'userAvatar'],
    ] as const) {
      if (workflow.includes(placeholder) && id) {
        const avatar = await ctx.host.readAvatar(kind, id)
        settings[key] = avatar ? (await sharp(avatar).png().toBuffer()).toString('base64') : ''
      }
    }
  }
  return {
    settings,
    input: { ...input, input: prepared.text, characterId: prepared.character.id },
    prepared,
    ...size,
    character,
  }
}
async function writePrompt(ctx: Context, snapshot: Snapshot, signal?: AbortSignal) {
  const { settings, input, prepared } = snapshot
  let text: string
  if (input.mode === 'raw_last') text = settings.minimalProcessing ? prepared.text : rawPrompt(prepared.text)
  else if (input.mode === 'free' && prepared.text.startsWith('!')) text = prepared.text.slice(1)
  else {
    let avatar: Uint8Array | null = null
    if (settings.multimodalCaptioning && ['character', 'face', 'user'].includes(input.mode)) {
      const id = input.mode === 'user' ? prepared.info.persona.id : prepared.character.id
      if (id) avatar = await ctx.host.readAvatar(input.mode === 'user' ? 'persona' : 'character', id)
    }
    const template = settings[`tpl_${input.mode}`]
    const instruction = avatar
      ? `请详细描述图中角色的外貌，输出英文逗号分隔的关键词，以 ${input.mode === 'face' ? 'close-up portrait' : 'full body portrait'} 开头。`
      : replaceTemplate(typeof template === 'string' ? template : (templates[input.mode] ?? ''), {
          char: prepared.character.name,
          user: prepared.info.persona.name,
          input: prepared.text,
        })
    text = await ctx.host.quietPrompt({
      chatId: input.chatId,
      speakerId: prepared.character.id,
      includeHistory: settings.promptWithHistory,
      instruction: `${instruction}\n${templateEnding}`,
      connectionId: settings.promptConnectionId || undefined,
      model: settings.promptModel || undefined,
      avatar: avatar ?? undefined,
      signal,
    })
  }
  if (!cleanPrompt(text, settings.minimalProcessing))
    throw new HttpError(502, 'IMAGE_PROMPT', '模型没有返回可用的图片提示词')
  if (input.mode === 'free') {
    const sd = prepared.character.extensions.sd_character_prompt as
      | { positive?: unknown; negative?: unknown }
      | undefined
    const positive = typeof sd?.positive === 'string' ? sd.positive : ''
    const requested = prepared.text.includes('{{charPrefix}}') || text.includes('{{charPrefix}}')
    if (requested && typeof sd?.negative === 'string') snapshot.character.negative = sd.negative
    text = text.replaceAll('{{charPrefix}}', positive)
    if (requested && positive && !text.includes(positive)) text = `${positive}, ${text}`
  }
  Object.assign(snapshot, composePrompt(settings, input.mode, text, snapshot.character, input.negative))
  return snapshot
}
export async function promptPreview(ctx: Context, input: GenerateInput) {
  const snapshot = await writePrompt(ctx, await freeze(ctx, input))
  for (const [id, item] of previews) if (item.expires < Date.now()) previews.delete(id)
  const snapshotId = crypto.randomUUID()
  previews.set(snapshotId, { expires: Date.now() + 3600000, snapshot })
  return {
    snapshotId,
    prompt: snapshot.prompt,
    negative: snapshot.negative,
    width: snapshot.width,
    height: snapshot.height,
    source: snapshot.settings.source,
    model: snapshot.settings.source === 'openai' ? snapshot.settings.openaiModel : snapshot.settings.comfyCheckpoint,
    workflow:
      snapshot.settings.comfyWorkflowName === 'avatar'
        ? '角色头像图生图'
        : snapshot.settings.comfyWorkflowName || '内置默认',
  }
}
function safeSnapshot(settings: Settings) {
  const {
    openaiApiKey: _key,
    comfyHeaders: _headers,
    openaiHeaders: _openaiHeaders,
    charAvatar: _char,
    userAvatar: _user,
    ...safe
  } = settings
  return safe
}
function safeError(error: unknown, settings: Settings) {
  let text = errorText(error)
  const secrets = [settings.openaiApiKey]
  try {
    secrets.push(...Object.values(comfyHeaders(settings)), ...Object.values(openaiHeaders(settings)))
  } catch {
    /* 无效请求头本身不包含在错误里。 */
  }
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[鉴权信息]')
  return text.replace(/[A-Za-z0-9+/=]{100,}/g, '[图片数据]')
}
export async function renderImage(
  ctx: Context,
  settings: Settings,
  prompt: string,
  width: number,
  height: number,
  chatId?: string,
  signal?: AbortSignal,
  stage?: (stage: ImageGenMeta['stage'], position?: number) => void,
) {
  const started = Date.now()
  const request = { ...safeSnapshot(settings), prompt, width, height }
  try {
    validate(settings)
    imageQueue.setLimit(settings.maxConcurrent)
    const bytes = await imageQueue.run(
      async () => {
        stage?.('generating')
        return settings.source === 'openai'
          ? generateOpenAI(settings, prompt, width, height, signal)
          : generateComfy(settings, prompt, width, height, signal)
      },
      signal,
      (position) => stage?.('queued', position),
    )
    signal?.throwIfAborted()
    ctx.host.log({
      chatId,
      kind: 'image',
      status: 'ok',
      model: settings.source === 'openai' ? settings.openaiModel : settings.comfyCheckpoint,
      durationMs: Date.now() - started,
      summary: `${settings.source}：${prompt.slice(0, 60)}`,
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
      summary: `${settings.source}：${prompt.slice(0, 60)}`,
      request,
      response: {
        error: signal?.aborted ? '已取消' : safeError(error, settings),
      },
    })
    throw error
  }
}
async function background(ctx: Context, chatId: string, bytes: Uint8Array, name: string) {
  const saved = await ctx.host.saveBackground(bytes, {
    source: 'generated',
    name: `${name} 背景 ${new Date().toLocaleString('zh-CN')}`,
  })
  ctx.host.setChatBackground(chatId, saved.id)
  return { background: saved }
}
function caption(snapshot: Snapshot) {
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
  const controller = tasks.get(messageId)
  if (!controller) throw new HttpError(400, 'IMAGE_TASK', '没有可取消的图片任务')
  controller.abort(new Error('已取消'))
  const message = loadMessage(messageId)
  return {
    message: ctx.host.updateMessageMeta(messageId, {
      imageGen: { ...message.meta.imageGen!, status: 'error', error: '已取消' },
      imageIndex: message.meta.images?.length ?? 0,
    }),
  }
}
export async function generate(ctx: Context, input: GenerateInput) {
  let snapshot: Snapshot
  if (input.snapshotId) {
    const preview = previews.get(input.snapshotId)
    if (
      !preview ||
      preview.expires < Date.now() ||
      preview.snapshot.input.chatId !== input.chatId ||
      preview.snapshot.input.mode !== input.mode
    )
      throw new HttpError(400, 'IMAGE_PREVIEW', '提示词预览已过期，请重新生成预览')
    snapshot = structuredClone(preview.snapshot)
    previews.delete(input.snapshotId)
  } else snapshot = await freeze(ctx, input)
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
  let pending: Awaited<ReturnType<typeof appendImage>> | undefined
  const controller = new AbortController()
  const pendingReady =
    settings.async && input.mode !== 'background'
      ? appendImage(ctx, input.chatId, {
          role: 'assistant',
          content: '',
          speakerId: prepared.character.id,
          meta: { name: prepared.character.name, imageGen: { ...meta } },
        }).then((message) => {
          pending = message
          tasks.set(message.id, controller)
          ctx.host.updateMessageMeta(message.id, { imageGen: { ...meta } })
          return message
        })
      : Promise.resolve(undefined)
  const stage = (value: ImageGenMeta['stage'], position?: number) => {
    controller.signal.throwIfAborted()
    meta.stage = value
    meta.queuePosition = position
    if (pending) ctx.host.updateMessageMeta(pending.id, { imageGen: { ...meta } })
  }
  const run = async () => {
    try {
      if (snapshot.prompt === undefined) await writePrompt(ctx, snapshot, controller.signal)
      controller.signal.throwIfAborted()
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
        controller.signal,
        stage,
      )
      stage('saving')
      if (input.mode === 'background') {
        controller.signal.throwIfAborted()
        return await background(ctx, input.chatId, bytes, prepared.character.name)
      }
      await pendingReady
      const image = await ctx.host.saveImage(bytes)
      controller.signal.throwIfAborted()
      const final = {
        name: prepared.character.name,
        images: [image],
        imageIndex: 0,
        imageGen: { ...meta, status: 'done' as const },
      }
      const message = pending
        ? ctx.host.updateMessageMeta(pending.id, final)
        : await appendImage(ctx, input.chatId, {
            role: 'assistant',
            content: '',
            speakerId: prepared.character.id,
            meta: final,
          })
      ctx.storage.set(`request:${message.id}`, snapshot)
      return { message }
    } catch (error) {
      await pendingReady
      if (!pending) throw error
      if (tasks.get(pending.id) !== controller) return { message: pending }
      return {
        message: ctx.host.updateMessageMeta(pending.id, {
          imageGen: { ...meta, status: 'error', error: controller.signal.aborted ? '已取消' : errorText(error) },
          imageIndex: 0,
        }),
      }
    } finally {
      if (pending && tasks.get(pending.id) === controller) {
        tasks.delete(pending.id)
        ctx.storage.set(`request:${pending.id}`, snapshot)
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
    throw new HttpError(409, 'IMAGE_DISMISS', '只能放弃失败或已取消的图片任务')
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
    throw new HttpError(409, 'IMAGE_BUSY', '这张图片正在重新生成')
  if (!old) throw new HttpError(400, 'IMAGE_RETRY', '这条消息没有可重试的图片任务')
  retryLocks.add(messageId)
  const controller = new AbortController()
  tasks.set(messageId, controller)
  let snapshot = ctx.storage.get<Snapshot>(`request:${messageId}`)
  // 重试 / 重新生成用「当前」的接口设置（后端、模型、地址、密钥、请求头、工作流、采样参数……）：
  // 失败往往正是因为设置不对，用户改好设置后再点重试必须生效。
  // 和这张图本身相关的内容沿用原任务：提示词、负面提示词、画幅比例、冻结的头像数据
  let settings: Settings
  try {
    settings = structuredClone(resolveImageConnection(parseSettings(ctx.settings)))
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
  if (settings.source === 'openai') {
    const [width, height] = fitOpenaiSize(settings, size.width, size.height).split('x').map(Number)
    size = { width: width!, height: height! }
  }
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
    try {
      let prompt = meta.prompt
      if (!prompt) {
        if (!snapshot) throw new Error('缺少原始生成描述，请重新发起图片生成')
        snapshot = await writePrompt(ctx, { ...snapshot, settings }, controller.signal)
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
        controller.signal.throwIfAborted()
        meta.stage = value
        meta.queuePosition = position
        ctx.host.updateMessageMeta(messageId, { imageGen: { ...meta } })
      }
      const bytes = await renderImage(
        ctx,
        settings,
        prompt!,
        size.width,
        size.height,
        message.chatId,
        controller.signal,
        stage,
      )
      stage('saving')
      const image = await ctx.host.saveImage(bytes)
      controller.signal.throwIfAborted()
      const images = append ? [...(loadMessage(messageId).meta.images ?? []), image] : [image]
      return {
        message: ctx.host.updateMessageMeta(messageId, {
          images,
          imageIndex: images.length - 1,
          imageGen: { ...meta, status: 'done' },
        }),
      }
    } catch (error) {
      if (tasks.get(messageId) !== controller) return { message: pending }
      const result = {
        message: ctx.host.updateMessageMeta(messageId, {
          imageGen: { ...meta, status: 'error', error: controller.signal.aborted ? '已取消' : errorText(error) },
          imageIndex: loadMessage(messageId).meta.images?.length ?? 0,
        }),
      }
      return result
    } finally {
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
  const message = loadMessage(messageId)
  const image = message.meta.images?.[index]
  if (!image) throw new HttpError(400, 'IMAGE_MISSING', '这条消息没有指定的图片')
  getAttachment(image.id)
  return await background(
    ctx,
    chatId ?? message.chatId,
    new Uint8Array(await Bun.file(join(paths.attachments, `${image.id}.webp`)).arrayBuffer()),
    message.meta.name ?? '图片',
  )
}
export async function testImage(ctx: Context) {
  const settings = resolveImageConnection(parseSettings(ctx.settings))
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
export async function runImageTool(ctx: ExtensionContext, args: Record<string, unknown>): Promise<ToolResult> {
  let meta: ImageGenMeta = { status: 'error', mode: 'tool' }
  try {
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('图片提示词不能为空')
    const snapshot = await freeze(ctx, { chatId: ctx.chatId, mode: 'character', prompt: args.prompt })
    const { settings, prepared } = snapshot
    let size = dimensions(settings, args.orientation === 'landscape', 'tool')
    if (args.orientation === 'square') size.height = size.width
    if (settings.source === 'openai') {
      const [width, height] = fitOpenaiSize(settings, size.width, size.height).split('x').map(Number)
      size = { width: width!, height: height! }
    }
    const combined = composePrompt(
      settings,
      'tool',
      args.prompt,
      characterPrompt('tool', prepared.character.extensions, !!prepared.info.chat.groupId),
    )
    Object.assign(snapshot, combined, size)
    settings.negativePrompt = combined.negative
    meta = {
      status: 'pending',
      stage: 'queued',
      mode: 'tool',
      prompt: combined.prompt,
      negative: combined.negative,
      seed: settings.seed,
      hidden: !settings.visibleFromTool,
      caption: caption(snapshot),
      ...size,
    }
    const run = async (messageId?: string): Promise<ToolResult> => {
      const controller = new AbortController()
      if (messageId) {
        tasks.set(messageId, controller)
        ctx.storage.set(`request:${messageId}`, snapshot)
      }
      try {
        const stage = (value: ImageGenMeta['stage'], position?: number) => {
          controller.signal.throwIfAborted()
          meta = { ...meta, stage: value, queuePosition: position }
          if (messageId) ctx.host.updateMessageMeta(messageId, { imageGen: meta })
        }
        const bytes = await renderImage(
          ctx,
          settings,
          combined.prompt,
          size.width,
          size.height,
          ctx.chatId,
          controller.signal,
          stage,
        )
        stage('saving')
        if (args.as_background === true) {
          await background(ctx, ctx.chatId, bytes, prepared.character.name)
          if (messageId) ctx.host.updateMessageMeta(messageId, { imageGen: { ...meta, status: 'done' } })
          return { content: '已生成并设为聊天背景。' }
        }
        const image = await ctx.host.saveImage(bytes)
        controller.signal.throwIfAborted()
        const result = {
          content: '图片已生成并展示给用户。',
          meta: { images: [image], imageIndex: 0, imageGen: { ...meta, status: 'done' as const } },
        }
        if (messageId) ctx.host.updateMessageMeta(messageId, result.meta)
        return result
      } catch (error) {
        const result = {
          content: `图片生成失败：${errorText(error)}`,
          meta: {
            imageGen: {
              ...meta,
              status: 'error' as const,
              error: controller.signal.aborted ? '已取消' : errorText(error),
            },
          },
        }
        if (messageId && tasks.get(messageId) === controller) ctx.host.updateMessageMeta(messageId, result.meta)
        return result
      } finally {
        if (messageId && tasks.get(messageId) === controller) tasks.delete(messageId)
      }
    }
    if (!settings.async) return await run()
    let started = false
    return {
      content: '图片正在生成，完成后会自动展示给用户，你不需要等待，继续写回复即可。',
      meta: { imageGen: meta },
      onSaved(messageId) {
        if (started) return
        started = true
        void run(messageId).catch(console.error)
      },
    }
  } catch (error) {
    return {
      content: `图片生成失败：${errorText(error)}`,
      meta: { imageGen: { ...meta, status: 'error', error: errorText(error) } },
    }
  }
}
