import { HttpError } from '../../../../errors'
import { t } from '../../../../i18n'
import { loadMessage } from '../../../../services/chats'
import { currentUser } from '../../../../user-context'
import { backendDimensions, getBackend } from '../backends'
import { characterPrompt, composePrompt, dimensions, resolvePromptStyle } from '../composition'
import { comfyHeaders, openaiHeaders, parseHeaders, resolveImageConnection } from '../discovery'
import { cleanPrompt, rawPrompt, templateEndings, templates } from '../modes'
import { generatedPrompt, imageInstruction, imageSourceText } from '../prompting'
import { parseSettings, type Settings } from '../settings'
import { workflowSource } from '../workflow'
import { previews } from './state'
import type { Context, GenerateInput } from './types'

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
export function validate(settings: Settings) {
  getBackend(settings).validate(settings)
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
export interface Snapshot {
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
export async function freeze(ctx: Context, input: GenerateInput): Promise<Snapshot> {
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
export async function writePrompt(ctx: Context, snapshot: Snapshot, signal?: AbortSignal, refine = false) {
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
export function safeSnapshot(settings: Settings) {
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
export function safeError(error: unknown, settings: Settings) {
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
