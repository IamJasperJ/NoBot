import { spritePrompt } from '@ai-parter/core/stage'
import { type GenerateSpritesInput, generateSpritesInput, type SpriteJobDTO } from '@ai-parter/shared'
import { newId } from '../db/client'
import { HttpError, notFound } from '../errors'
import { backendDimensions, getBackend } from '../extensions/builtin/image-gen/backends'
import { imageMime as getImageMime } from '../extensions/builtin/image-gen/backends/types'
import {
  characterPrompt,
  composePrompt,
  dimensions,
  resolvePromptStyle,
} from '../extensions/builtin/image-gen/composition'
import { resolveImageConnection } from '../extensions/builtin/image-gen/discovery'
import { cleanPrompt, promptInstruction, templates } from '../extensions/builtin/image-gen/modes'
import { type Context, renderImage } from '../extensions/builtin/image-gen/pipeline'
import { parseSettings } from '../extensions/builtin/image-gen/settings'
import { t } from '../i18n'
import { chatCompletion } from '../llm/openai'
import { getCharacter } from './characters'
import { getApiPresetRow, resolveApiPreset } from './connections'
import { insertLog } from './logs'
import { selectProfile } from './profiles'
import { requireCharacter, saveSprite, transparentSprite } from './sprites'

const jobs = new Map<string, { characterId: string; progress: SpriteJobDTO }>()
const running = new Set<string>()

/** 即时校验和占锁先于异步任务，接口始终只返回任务编号。 */
export async function startSpriteJob(characterId: string, input: unknown): Promise<{ jobId: string }> {
  requireCharacter(characterId)
  const data = generateSpritesInput.parse(input)
  const { imageGenerationContext } = await import('../extensions/registry')
  const ctx = imageGenerationContext('', characterId)
  getBackend(resolveImageConnection(parseSettings(ctx.settings))).validate(
    resolveImageConnection(parseSettings(ctx.settings)),
  )
  if (running.has(characterId)) throw new HttpError(409, 'SPRITE_BUSY', t('该角色正在生成立绘'))
  const jobId = newId()
  const progress: SpriteJobDTO = { total: new Set(data.expressions).size, done: 0, failed: 0, status: 'pending' }
  // 只清理已完成的旧任务，正在运行的任务始终可查询。
  if (jobs.size >= 200)
    for (const [id, job] of jobs) {
      if (job.progress.status === 'done' || job.progress.status === 'error') {
        jobs.delete(id)
        break
      }
    }
  jobs.set(jobId, { characterId, progress })
  void generateSpriteSet(ctx, characterId, data, undefined, progress).catch((error) => {
    progress.failed = progress.total - progress.done
    progress.status = 'error'
    ctx.host.log({ kind: 'image', status: 'error', summary: String(error) })
  })
  return { jobId }
}

export function spriteJob(characterId: string, jobId: string): SpriteJobDTO {
  requireCharacter(characterId)
  const job = jobs.get(jobId)
  if (!job || job.characterId !== characterId) throw notFound(t('立绘生成任务'))
  return { ...job.progress }
}

export async function generateSpriteSet(
  ctx: Context,
  characterId: string,
  input: GenerateSpritesInput,
  chatId?: string,
  progress?: SpriteJobDTO,
): Promise<SpriteJobDTO> {
  if (running.has(characterId)) throw new HttpError(409, 'SPRITE_BUSY', t('该角色正在生成立绘'))
  running.add(characterId)
  const expressions = [...new Set(input.expressions)]
  if (expressions.includes('neutral')) expressions.sort((a, b) => Number(b === 'neutral') - Number(a === 'neutral'))
  const state = progress ?? { total: expressions.length, done: 0, failed: 0, status: 'pending' }
  state.status = 'running'
  try {
    const settings = structuredClone(resolveImageConnection(parseSettings(ctx.settings)))
    const style = resolvePromptStyle(settings)
    const character = getCharacter(characterId)
    let appearance = input.basePrompt
    if (!appearance) {
      const instruction = `${promptInstruction('character', settings.tpl_character || templates.character, style)}\nCharacter name: ${character.name}\nCharacter description: ${character.description}\nPersonality: ${character.personality}\nOutput only an English image prompt describing physical appearance, hair, eyes, body and clothing. No scenery or other characters. Choose one coherent outfit and one hairstyle. Do not combine alternate outfits, hairstyles or changing appearance states.`
      if (chatId)
        appearance = await ctx.host.quietPrompt({
          chatId,
          speakerId: characterId,
          instruction,
          includeHistory: false,
          connectionId: settings.promptConnectionId || undefined,
          model: settings.promptModel || undefined,
        })
      else {
        const profile = selectProfile({ characterId, groupId: null, profileId: null }).profile
        const connection = settings.promptConnectionId
          ? getApiPresetRow(settings.promptConnectionId)
          : resolveApiPreset(profile?.apiPresetId ?? null)
        const body = {
          model: settings.promptModel || connection.model,
          stream: false,
          messages: [{ role: 'user', content: instruction }],
        }
        appearance = ''
        const started = Date.now()
        for await (const chunk of chatCompletion({
          baseUrl: connection.baseUrl,
          apiKey: connection.apiKey,
          headers: connection.headers,
          body,
          signal: new AbortController().signal,
        }))
          appearance += chunk.text ?? ''
        insertLog({
          kind: 'image',
          status: 'ok',
          model: body.model,
          durationMs: Date.now() - started,
          summary: t('立绘外貌提示词'),
          request: body,
          response: { content: appearance },
        })
      }
      appearance = cleanPrompt(
        appearance.replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, ''),
        settings.minimalProcessing,
      )
      if (!appearance) throw new Error(t('模型没有返回可用的图片提示词'))
    }
    settings.seed = settings.seed === -1 ? Math.floor(Math.random() * 2 ** 48) : settings.seed
    let size = dimensions(settings, false, 'character')
    size = backendDimensions(settings, Math.min(size.width, size.height), Math.max(size.width, size.height))
    let seed = settings.seed
    let referenceImage: string | undefined
    const useReference = getBackend(settings).supportsReference?.(settings) === true
    for (const expression of expressions) {
      try {
        const composed = composePrompt(
          settings,
          'character',
          spritePrompt(appearance, expression, input.outfit, style),
          characterPrompt('character', character.extensions, false),
        )
        settings.negativePrompt = composed.negative
        settings.seed = seed
        const prompt = referenceImage
          ? `${composed.prompt}. Edit the supplied reference sprite: change only the facial expression. Preserve the exact identity, face shape, hairstyle, outfit, body proportions, standing pose, camera, framing, lighting, rendering style and white background. Do not redesign the character.`
          : composed.prompt
        const bytes = await renderImage(
          ctx,
          settings,
          prompt,
          size.width,
          size.height,
          chatId,
          undefined,
          undefined,
          referenceImage,
        )
        if (expression === expressions[0]) seed = settings.seed
        await saveSprite(characterId, await transparentSprite(bytes), input.outfit, expression)
        // 以第一张成功保存的原始白底图固定整套外观，不把去底边缘传回模型。
        if (useReference && !referenceImage)
          referenceImage = `data:${getImageMime(bytes)};base64,${Buffer.from(bytes).toString('base64')}`
        state.done++
      } catch (error) {
        state.failed++
        ctx.host.log({ chatId, kind: 'image', status: 'error', summary: String(error) })
      }
    }
    state.status = state.failed ? 'error' : 'done'
    return { ...state }
  } finally {
    running.delete(characterId)
  }
}
