import type { MessageMeta, PlayPresetData, StageState } from '@nobot/shared'
import { t } from '../../../../i18n'
import { firstJsonObject } from '../../../../lib/json-object'
import { getChatRow, loadPath } from '../../../../services/chats'
import { computeStage } from '../../../../services/generation/stage'
import { getLanguage } from '../../../../services/settings'
import { backendDimensions } from '../backends'
import { composePrompt, dimensions } from '../composition'
import type { Settings } from '../settings'
import { freeze, safeError, writePrompt } from './prompt'
import { renderImage } from './render'
import { backgroundTasks } from './state'
import type { Context } from './types'

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
export async function background(
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
