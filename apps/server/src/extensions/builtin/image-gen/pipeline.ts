import { join } from 'node:path'
import type { ImageGenMeta, MessageMeta, PlayPresetData, StageState } from '@nobot/shared'
import { paths } from '../../../env'
import { HttpError } from '../../../errors'
import { t } from '../../../i18n'
import { firstJsonObject } from '../../../lib/json-object'
import { getAttachment } from '../../../services/attachments'
import { deleteMessage, editMessage, getChatRow, loadMessage, loadPath } from '../../../services/chats'
import { getLanguage } from '../../../services/settings'
import { computeStage, resolvePlayPreset } from '../../../services/stage'
import type { ToolResult } from '../../../tools'
import { currentUser } from '../../../user-context'
import type { ExtensionContext } from '../../types'
import { backendDimensions, getBackend } from './backends'
import { characterPrompt, composePrompt, dimensions, resolvePromptStyle } from './composition'
import { comfyHeaders, openaiHeaders, parseHeaders, resolveImageConnection } from './discovery'
import { cleanPrompt, type Mode, rawPrompt, templateEndings, templates } from './modes'
import { generatedPrompt, imageInstruction, imageSourceText } from './prompting'
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
  backgroundName?: string
}
const imageQueues = new Map<string, Semaphore>()
const tasks = new Map<string, AbortController>()
const retryLocks = new Set<string>()
const previews = new Map<string, { expires: number; snapshot: Snapshot }>()
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
function validate(settings: Settings) {
  getBackend(settings).validate(settings)
}
async function appendImage(ctx: Context, chatId: string, message: Parameters<Context['host']['appendMessage']>[1]) {
  const deadline = Date.now() + 600000
  do {
    if (Date.now() >= deadline) throw new Error(t('等待文本生成结束超时，请稍后再试'))
    await ctx.host.waitIdle(chatId, deadline - Date.now())
  } while (ctx.host.isGenerating(chatId))
  return ctx.host.appendMessage(chatId, message)
}
function prepare(ctx: Context, input: GenerateInput) {
  const info = ctx.host.getChatInfo(input.chatId, 1000)
  let source = input.mode === 'message' && input.messageId ? loadMessage(input.messageId) : undefined
  if (input.mode === 'message') {
    if (!input.messageId) throw new HttpError(400, 'IMAGE_MESSAGE', t('请指定消息'))
    if (source?.chatId !== input.chatId) throw new HttpError(400, 'IMAGE_MESSAGE', t('指定消息不属于这个会话'))
  } else if (['last', 'raw_last', 'scene'].includes(input.mode)) {
    // 图片通知、工具结果和系统消息不是待绘制的剧情，不能让连续出图反复提炼上一张图片。
    source = [...info.messages]
      .reverse()
      .find(
        (m) => ['assistant', 'user'].includes(m.role) && !m.meta.imageGen && m.status !== 'error' && m.content.trim(),
      )
  }
  const lastSpeaker = [...info.messages]
    .reverse()
    .find((m) => m.speakerId && info.characters.some((c) => c.id === m.speakerId))?.speakerId
  const character =
    info.characters.find((c) => c.id === (input.characterId ?? source?.speakerId ?? lastSpeaker)) ??
    info.characters.find((c) => !c.muted) ??
    info.characters[0]
  if (!character || (input.characterId && !info.characters.some((c) => c.id === input.characterId)))
    throw new HttpError(400, 'IMAGE_CHARACTER', t('会话中没有这个角色'))
  let text = input.input ?? ''
  if (source && (input.mode === 'message' || input.input === undefined)) text = source.content
  if (input.prompt === undefined && ['free', 'last', 'raw_last', 'message'].includes(input.mode) && !text.trim())
    throw new HttpError(400, 'IMAGE_INPUT', t('没有可用于生成图片的描述'))
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
  const settings = structuredClone(resolveImageConnection(parseSettings(ctx.settings), false))
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
  size = backendDimensions(settings, size.width, size.height)
  const character = characterPrompt(
    input.mode,
    prepared.character.extensions,
    !!prepared.info.chat.groupId,
    !!input.characterId,
  )
  // 在任何异步工作开始前冻结角色外貌、设置与随机种子。
  settings.seed = settings.seed === -1 ? Math.floor(Math.random() * 2 ** 48) : settings.seed
  settings.comfyCustomPlaceholders = settings.comfyCustomPlaceholders.map((item) => ({
    ...item,
    replace: item.replace.replace(/{{(char|user)}}/g, (_, key) =>
      key === 'char' ? prepared.character.name : prepared.info.persona.name,
    ),
  }))
  const workflow = workflowSource(settings)
  if (getBackend(settings).prepareAvatars) {
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
async function writePrompt(ctx: Context, snapshot: Snapshot, signal?: AbortSignal, refine = false) {
  const { settings, input, prepared } = snapshot
  let text: string
  if (input.mode === 'raw_last') text = settings.minimalProcessing ? prepared.text : rawPrompt(prepared.text)
  else if (!refine && input.mode === 'free' && (prepared.text.startsWith('!') || !settings.freeExtend))
    text = prepared.text.startsWith('!') ? prepared.text.slice(1) : prepared.text
  else {
    let avatar: Uint8Array | null = null
    if (settings.multimodalCaptioning && ['character', 'face', 'user'].includes(input.mode)) {
      const id = input.mode === 'user' ? prepared.info.persona.id : prepared.character.id
      if (id) avatar = await ctx.host.readAvatar(input.mode === 'user' ? 'persona' : 'character', id)
    }
    const template = settings[`tpl_${input.mode}`]
    const style = resolvePromptStyle(settings)
    const builtin = !template || template === templates[input.mode]
    const instruction =
      avatar && builtin
        ? `Describe the visible appearance of the character in the image using ${input.mode === 'face' ? 'close-up portrait' : 'full body portrait'} framing.\n${templateEndings[style]}`
        : imageInstruction(input.mode, template, style, {
            char: prepared.character.name,
            user: prepared.info.persona.name,
            input: imageSourceText(
              prepared.text,
              prepared.info.characters.map((c) => c.name),
            ),
          })
    text = await ctx.host.quietPrompt({
      chatId: input.chatId,
      speakerId: prepared.character.id,
      includeHistory: settings.promptWithHistory,
      leafId: prepared.info.chat.activeLeafId,
      purpose: 'image',
      instruction,
      connectionId: settings.promptConnectionId || undefined,
      model: settings.promptModel || undefined,
      avatar: avatar ?? undefined,
      signal,
    })
    text = generatedPrompt(text, settings.minimalProcessing)
  }
  if (!cleanPrompt(text, settings.minimalProcessing))
    throw new HttpError(502, 'IMAGE_PROMPT', t('模型没有返回可用的图片提示词'))
  if (input.mode === 'free') {
    const sd = prepared.character.extensions.sd_character_prompt as
      | { positive?: unknown; negative?: unknown }
      | undefined
    const positive = typeof sd?.positive === 'string' ? sd.positive : ''
    const requested = /^!?char(?:\s|,)/i.test(prepared.text) || /{{charPrefix}}/i.test(prepared.text + text)
    if (requested && typeof sd?.negative === 'string') snapshot.character.negative = sd.negative
    text = text.replace(
      /^char(\s|,)|{{charPrefix}}/gi,
      (_, separator: string | undefined) => positive + (separator ?? ''),
    )
    if (requested && positive && !text.includes(positive)) text = `${positive}, ${text}`
  }
  Object.assign(snapshot, composePrompt(settings, input.mode, text, snapshot.character, input.negative))
  return snapshot
}
export async function promptPreview(ctx: Context, input: GenerateInput) {
  const snapshot = await writePrompt(ctx, await freeze(ctx, input))
  for (const [id, item] of previews) if (item.expires < Date.now()) previews.delete(id)
  const snapshotId = crypto.randomUUID()
  previews.set(`${currentUser().handle}:${snapshotId}`, { expires: Date.now() + 3600000, snapshot })
  return {
    snapshotId,
    prompt: snapshot.prompt,
    negative: snapshot.negative,
    width: snapshot.width,
    height: snapshot.height,
    source: snapshot.settings.source,
    model: getBackend(snapshot.settings).model(snapshot.settings),
    workflow:
      snapshot.settings.comfyWorkflowName === 'avatar'
        ? t('角色头像图生图')
        : snapshot.settings.comfyWorkflowName || t('内置默认'),
  }
}
function safeSnapshot(settings: Settings) {
  const {
    openaiApiKey: _key,
    openrouterApiKey: _routerKey,
    openrouterHeaders: _routerHeaders,
    a1111Auth: _auth,
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
  const secrets = [
    settings.openaiApiKey,
    settings.openrouterApiKey,
    settings.a1111Auth,
    Buffer.from(settings.a1111Auth).toString('base64'),
  ]
  try {
    secrets.push(
      ...Object.values(comfyHeaders(settings)),
      ...Object.values(openaiHeaders(settings)),
      ...Object.values(parseHeaders(settings.openrouterHeaders, 'OpenRouter ')),
    )
  } catch {
    /* 无效请求头本身不包含在错误里。 */
  }
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, t('[鉴权信息]'))
  return text.replace(/[A-Za-z0-9+/=]{100,}/g, t('[图片数据]'))
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
/** 场景名优先保证舞台立即匹配；模型起名失败只影响元数据，不影响出图。 */
export async function nameBackground(
  ctx: Pick<Context, 'host'>,
  chatId: string,
  settings: Settings,
  prompt: string,
  characterName: string,
) {
  const chat = getChatRow(chatId)
  const stage = computeStage(chatId, loadPath(chat.activeLeafId))
  const sceneName = stage?.scene.backgroundId === null ? stage.scene.bg?.trim() : undefined
  let name =
    sceneName ||
    (stage?.scene.place?.trim()
      ? [stage.scene.place.trim(), stage.scene.time?.trim()].filter(Boolean).join(' ')
      : '') ||
    prompt
      .split(',')
      .map((part) => part.trim())
      .filter(
        (part) =>
          part &&
          !/^(?:best quality|high quality|highest quality|masterpiece|highly detailed|ultra detailed|ultra-detailed|highres|high res|high resolution|[48]k|scenery|no humans)$/i.test(
            part,
          ),
      )
      .slice(0, 3)
      .join(', ') ||
    t('{name} 背景 {time}', {
      name: characterName,
      time: new Date().toLocaleString(getLanguage() === 'en' ? 'en-US' : 'zh-CN'),
    })
  let description = ''
  try {
    const reply = await ctx.host.complete({
      chatId,
      summary: t('背景起名'),
      connectionId: settings.promptConnectionId || undefined,
      model: settings.promptModel || undefined,
      messages: [
        {
          role: 'user',
          content: `The following describes a background image. Give it a short name (2–10 words or Chinese characters), using the location plus any necessary time or mood, such as "Tavern at dusk". Describe the image in one sentence of at most 40 words or Chinese characters. Write in ${getLanguage() === 'en' ? 'English' : 'Chinese'}. Output only JSON: {"name": "...", "description": "..."}
Image description: ${prompt}`,
        },
      ],
    })
    const start = reply.indexOf('{')
    if (start < 0) throw new Error(t('模型没有返回 JSON'))
    const value = firstJsonObject(reply)
    if (!value || typeof value !== 'object') throw new Error(t('模型返回的 JSON 无效'))
    if (!sceneName) {
      if (!('name' in value) || typeof value.name !== 'string' || !value.name.trim()) {
        throw new Error(t('模型返回的名字为空'))
      }
      name = value.name.trim()
    }
    if ('description' in value && typeof value.description === 'string') {
      description = Array.from(value.description.trim()).slice(0, 40).join('')
    }
  } catch (error) {
    ctx.host.log({
      chatId,
      kind: 'image',
      status: 'error',
      summary: t('背景起名失败：{error}', { error: safeError(error, settings) }),
    })
  }
  return { name, description }
}
async function background(
  ctx: Context,
  chatId: string,
  bytes: Uint8Array,
  name: string,
  settings: Settings,
  prompt: string,
  backgroundName?: string,
) {
  const metadata = await nameBackground(ctx, chatId, settings, prompt, name)
  const saved = await ctx.host.saveBackground(bytes, {
    source: 'generated',
    chatId,
    ...metadata,
    ...(backgroundName ? { name: backgroundName } : {}),
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
      let generatedBackground: Awaited<ReturnType<typeof background>> | undefined
      if (input.mode === 'background') {
        controller.signal.throwIfAborted()
        generatedBackground = await background(
          ctx,
          input.chatId,
          bytes,
          prepared.character.name,
          settings,
          snapshot.prompt!,
          input.backgroundName,
        )
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
      return { message, ...generatedBackground }
    } catch (error) {
      await pendingReady
      if (!pending) throw error
      if (tasks.get(pending.id) !== controller) return { message: pending }
      return {
        message: ctx.host.updateMessageMeta(pending.id, {
          imageGen: { ...meta, status: 'error', error: controller.signal.aborted ? t('已取消') : errorText(error) },
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
  retryLocks.add(messageId)
  const controller = new AbortController()
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
    try {
      let prompt = meta.prompt
      if (!prompt) {
        if (!snapshot) throw new Error(t('缺少原始生成描述，请重新发起图片生成'))
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
      if (old.mode === 'background') {
        await background(ctx, message.chatId, bytes, message.meta.name ?? '', settings, prompt!)
      }
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
          imageGen: { ...meta, status: 'error', error: controller.signal.aborted ? t('已取消') : errorText(error) },
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
  if (!image) throw new HttpError(400, 'IMAGE_MISSING', t('这条消息没有指定的图片'))
  getAttachment(image.id)
  return await background(
    ctx,
    chatId ?? message.chatId,
    new Uint8Array(await Bun.file(join(paths.attachments, `${image.id}.webp`)).arrayBuffer()),
    message.meta.name ?? t('图片'),
    resolveImageConnection(parseSettings(ctx.settings), false),
    message.meta.imageGen?.prompt ?? '',
  )
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
export async function runImageTool(ctx: ExtensionContext, args: Record<string, unknown>): Promise<ToolResult> {
  let meta: ImageGenMeta = { status: 'error', mode: 'tool' }
  try {
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
                controller.signal,
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
        } else await writePrompt(ctx, snapshot, controller.signal)
        settings.negativePrompt = snapshot.negative ?? ''
        meta = { ...meta, prompt: snapshot.prompt, negative: snapshot.negative, caption: caption(snapshot) }
        const bytes = await renderImage(
          ctx,
          settings,
          snapshot.prompt!,
          size.width,
          size.height,
          ctx.chatId,
          controller.signal,
          stage,
        )
        stage('saving')
        if (mode === 'background') {
          await background(ctx, ctx.chatId, bytes, prepared.character.name, settings, snapshot.prompt!)
        }
        const image = await ctx.host.saveImage(bytes)
        controller.signal.throwIfAborted()
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
        const result = {
          content: 'Image generation failed. The user can inspect the error and retry.',
          meta: {
            imageGen: {
              ...meta,
              status: 'error' as const,
              error: controller.signal.aborted ? t('已取消') : safeError(error, settings),
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
        editMessage(messageId, result.content)
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

const backgroundTasks = new Map<string, string>()

export function isBackgroundRunning(chatId: string): boolean {
  if (!chatId) return false
  getChatRow(chatId)
  return [...backgroundTasks.values()].includes(chatId)
}

/** 只为最新回复引入且尚未匹配的背景生成图片，避免普通续写反复触发。 */
export function missingBackground(
  play: PlayPresetData,
  message: { meta: MessageMeta } | undefined,
  stage: StageState | null,
): string | null {
  if (!play.directives.enabled || !play.stage.autoBackground || !stage || stage.scene.backgroundId !== null) return null
  const bg = stage.scene.bg?.trim()
  return bg && message?.meta.stage?.ops.some((op) => op.op === 'scene' && op.bg?.trim() === bg) ? bg : null
}

export async function autoBackground(ctx: Context, chatId: string): Promise<void> {
  try {
    const play = resolvePlayPreset(chatId).data
    if (!play.directives.enabled || !play.stage.autoBackground) return
    const path = loadPath(getChatRow(chatId).activeLeafId)
    const stage = computeStage(chatId, path)
    const bg = missingBackground(
      play,
      path.findLast((message) => message.role === 'assistant'),
      stage,
    )
    if (!bg) return
    validate(resolveImageConnection(parseSettings(ctx.settings), false))
    const key = JSON.stringify([chatId, bg])
    if (backgroundTasks.has(key)) return
    backgroundTasks.set(key, chatId)
    try {
      await generate(ctx, {
        chatId,
        mode: 'background',
        backgroundName: bg,
        input: `Location name: ${bg}; place: ${stage?.scene.place ?? ''}; time: ${stage?.scene.time ?? ''}`,
      })
    } finally {
      backgroundTasks.delete(key)
    }
  } catch (error) {
    ctx.host.log({
      chatId,
      kind: 'image',
      status: 'error',
      summary: t('自动背景生成失败：{error}', { error: errorText(error) }),
    })
  }
}

/** 为舞台资产出图，不创建独立消息，保留现有改写、风格合成及队列行为。 */
export async function stageImage(
  ctx: Context,
  chatId: string,
  prompt: string,
  mode: 'free' | 'character',
  characterId?: string,
  landscape = mode === 'free',
  transparent?: boolean,
) {
  const snapshot = await freeze(ctx, { chatId, mode, characterId, input: prompt, prompt })
  const settings = snapshot.settings
  if (settings.refineModelPrompts || mode === 'character') {
    try {
      await writePrompt(ctx, snapshot, undefined, settings.refineModelPrompts)
      prompt = snapshot.rawPrompt ?? prompt
    } catch (error) {
      ctx.host.log({ chatId, kind: 'image', status: 'error', summary: safeError(error, settings) })
      if (mode === 'character') throw error
    }
  }
  const composed = composePrompt(settings, mode, prompt, snapshot.character)
  settings.negativePrompt = composed.negative
  const requested = dimensions(settings, landscape, mode)
  const size = backendDimensions(
    settings,
    landscape ? Math.max(requested.width, requested.height) : Math.min(requested.width, requested.height),
    landscape ? Math.min(requested.width, requested.height) : Math.max(requested.width, requested.height),
  )
  return renderImage(
    ctx,
    settings,
    composed.prompt,
    size.width,
    size.height,
    chatId,
    undefined,
    undefined,
    undefined,
    transparent,
  )
}
