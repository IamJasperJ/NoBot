import type { AttachmentDTO, MessageMeta } from '@ai-parter/shared'
import { getSetting, setSetting } from '../../../db/client'
import { setAttachmentCg } from '../../../services/attachments'
import { getChatRow, loadMessage, loadPath } from '../../../services/chats'
import { generateSpriteSet } from '../../../services/sprite-generation'
import { listSprites, transparentSprite } from '../../../services/sprites'
import { computeStage, resolvePlayPreset } from '../../../services/stage'
import { type Context, stageImage } from './pipeline'

const actorTasks = new Set<string>()
const actorRuns = new Set<string>()

/** 元数据先同步占位再等待网络，重复事件与并发事件都不会重复启动。 */
export async function autoCgs(ctx: Context, chatId: string): Promise<void> {
  try {
    const play = resolvePlayPreset(chatId).data
    if (!play.directives.enabled || !play.directives.kinds.includes('cg') || !play.stage.cgAuto) return
    const message = loadPath(getChatRow(chatId).activeLeafId).findLast((message) => message.role === 'assistant')
    if (message?.status !== 'done' || message.meta.cg) return
    const cg: NonNullable<MessageMeta['cg']> = (message.meta.stage?.beats ?? []).flatMap((beat, index) =>
      beat.kind === 'cg' ? [{ beat: index, attachmentId: null, status: 'pending' as const, prompt: beat.prompt }] : [],
    )
    if (!cg.length) return
    ctx.host.updateMessageMeta(message.id, { cg })
    for (const entry of cg) {
      try {
        const bytes = await stageImage(ctx, chatId, entry.prompt, 'free', message.speakerId ?? undefined)
        const image = await ctx.host.saveImage(bytes)
        const marked = await setAttachmentCg(image.id, true)
        entry.attachmentId = marked.id
        entry.status = 'done'
        const latest = loadMessage(message.id)
        ctx.host.updateMessageMeta(message.id, { images: [...(latest.meta.images ?? []), marked], cg: [...cg] })
      } catch (error) {
        entry.status = 'error'
        ctx.host.updateMessageMeta(message.id, { cg: [...cg] })
        ctx.host.log({ chatId, kind: 'image', status: 'error', summary: String(error) })
      }
    }
  } catch (error) {
    ctx.host.log({ chatId, kind: 'image', status: 'error', summary: String(error) })
  }
}

/** 临时 NPC 附件保存在会话级设置中，名字键与舞台一致，重启后仍可寻址。 */
export async function autoActors(ctx: Context, chatId: string): Promise<void> {
  if (actorRuns.has(chatId)) return
  actorRuns.add(chatId)
  try {
    const play = resolvePlayPreset(chatId).data
    if (!play.directives.enabled || play.stage.unknownActor !== 'generate') return
    const path = loadPath(getChatRow(chatId).activeLeafId)
    const message = path.findLast((message) => message.role === 'assistant')
    if (message?.status !== 'done') return
    const stage = computeStage(chatId, path)
    let failed = false
    let started = false
    for (const actor of stage?.cast ?? []) {
      const lock = JSON.stringify([chatId, actor.key])
      const storageKey = `vn-actors:${chatId}`
      if (
        actorTasks.has(lock) ||
        (actor.characterId
          ? listSprites(actor.characterId).length
          : getSetting<Record<string, AttachmentDTO>>(storageKey)?.[actor.key]?.url)
      )
        continue
      actorTasks.add(lock)
      if (!started) {
        started = true
        ctx.host.updateMessageMeta(message.id, { spriteGeneration: 'pending' })
      }
      try {
        if (actor.characterId) {
          const result = await generateSpriteSet(
            ctx,
            actor.characterId,
            { outfit: actor.outfit ?? '', expressions: ['neutral'] },
            chatId,
          )
          if (result.failed) failed = true
        } else {
          const prompt = `Create a full body standing character sprite of ${actor.name}. Neutral expression, simple white background, no other characters. Use the conversation to infer appearance. Output only an English image description.`
          const appearance = await ctx.host.quietPrompt({ chatId, instruction: prompt, includeHistory: true })
          const bytes = await stageImage(
            ctx,
            chatId,
            `${appearance}. Full body, standing, neutral expression, simple white background, no other characters.`,
            'free',
            undefined,
            false,
          )
          const image = await ctx.host.saveImage(await transparentSprite(bytes))
          setSetting(storageKey, { ...getSetting<Record<string, AttachmentDTO>>(storageKey), [actor.key]: image })
        }
      } catch (error) {
        failed = true
        ctx.host.log({ chatId, kind: 'image', status: 'error', summary: String(error) })
      } finally {
        actorTasks.delete(lock)
      }
    }
    if (started) ctx.host.updateMessageMeta(message.id, { spriteGeneration: failed ? 'error' : 'done' })
  } catch (error) {
    ctx.host.log({ chatId, kind: 'image', status: 'error', summary: String(error) })
  } finally {
    actorRuns.delete(chatId)
  }
}
