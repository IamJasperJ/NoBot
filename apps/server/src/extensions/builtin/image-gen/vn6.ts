import type { AttachmentDTO, MessageMeta } from '@nobot/shared'
import { newId } from '../../../db/client'
import { removeAttachmentFiles, setAttachmentCg } from '../../../services/attachments'
import { getChatRow, loadPath } from '../../../services/chats'
import { reconcileCg } from '../../../services/generation/cg'
import { computeStage, resolvePlayPreset } from '../../../services/generation/stage'
import { generateSpriteSet } from '../../../services/sprites/sprite-generation'
import { listSprites } from '../../../services/sprites/sprites'
import { readTemporaryActors } from '../../../services/sprites/temporary-actors'
import { type Context, stageImage } from './pipeline'
import { imageTaskSignal } from './pipeline/state'
import { actorTaskKey, actorTasks, startTemporaryActor } from './temporary-actors'

const actorRuns = new Set<string>()

function pendingCgMessage(messageId: string, taskId: string) {
  const message = loadPath(messageId, 1)[0]
  const entry = message?.meta.cg?.find((item) => item.taskId === taskId && item.status === 'pending')
  const beat = entry && message?.meta.stage?.beats[entry.beat]
  return beat?.kind === 'cg' && beat.prompt === entry?.prompt ? message : undefined
}

function settleCg(ctx: Context, messageId: string, taskId: string, image?: AttachmentDTO) {
  const message = pendingCgMessage(messageId, taskId)
  if (!message) return false
  ctx.host.updateMessageMeta(messageId, {
    cg: message.meta.cg!.map((entry) =>
      entry.taskId === taskId
        ? { ...entry, status: image ? 'done' : 'error', attachmentId: image?.id ?? null, taskId: undefined }
        : entry,
    ),
    ...(image ? { images: [...(message.meta.images ?? []), image] } : {}),
  })
  return true
}

/** 元数据先同步占位再等待网络，重复事件与并发事件都不会重复启动。 */
export async function autoCgs(ctx: Context, chatId: string, messageId: string): Promise<void> {
  const signal = imageTaskSignal()
  try {
    const play = resolvePlayPreset(chatId).data
    if (!play.directives.enabled || !play.directives.kinds.includes('cg') || !play.stage.cgAuto) return
    const message = loadPath(messageId, 1)[0]
    if (
      message?.chatId !== chatId ||
      message.role !== 'assistant' ||
      message.status !== 'done' ||
      message.meta.error ||
      message.meta.toolCalls?.length
    )
      return
    const beats = message.meta.stage?.beats ?? []
    const retained = new Map(reconcileCg(beats, message.meta.cg ?? []).map((entry) => [entry.beat, entry]))
    const queued: { prompt: string; taskId: string }[] = []
    const cg: NonNullable<MessageMeta['cg']> = beats.flatMap((beat, index) => {
      if (beat.kind !== 'cg') return []
      const existing = retained.get(index)
      if (existing) return [existing]
      const entry = {
        beat: index,
        attachmentId: null,
        status: 'pending' as const,
        prompt: beat.prompt,
        taskId: newId(),
      }
      queued.push(entry)
      return [entry]
    })
    if (!queued.length) return
    ctx.host.updateMessageMeta(message.id, { cg })
    for (const entry of queued) {
      let image: AttachmentDTO | undefined
      let attached = false
      try {
        if (!pendingCgMessage(message.id, entry.taskId)) continue
        signal.throwIfAborted()
        const bytes = await stageImage(ctx, {
          chatId,
          prompt: entry.prompt,
          mode: 'free',
          characterId: message.speakerId ?? undefined,
          historyLeafId: message.id,
          signal,
        })
        signal.throwIfAborted()
        if (!pendingCgMessage(message.id, entry.taskId)) continue
        image = await ctx.host.saveImage(bytes)
        signal.throwIfAborted()
        const marked = await setAttachmentCg(image.id, true)
        signal.throwIfAborted()
        attached = settleCg(ctx, message.id, entry.taskId, marked)
      } catch (error) {
        if (settleCg(ctx, message.id, entry.taskId) && !signal.aborted)
          ctx.host.log({ chatId, kind: 'image', status: 'error', summary: String(error) })
      } finally {
        if (image && !attached) await removeAttachmentFiles(image.id)
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
  const signal = imageTaskSignal()
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
      if (signal.aborted) break
      const lock = actorTaskKey(chatId, actor.key)
      const existing = readTemporaryActors(chatId)[actor.key]
      if (
        actorTasks.has(lock) ||
        (actor.characterId ? listSprites(actor.characterId).length : existing && existing.status !== 'error')
      )
        continue
      if (actor.characterId) actorTasks.add(lock)
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
          const { task } = startTemporaryActor(ctx, chatId, actor.key, actor.name)
          if (!(await task)) failed = true
        }
      } catch (error) {
        failed = true
        ctx.host.log({ chatId, kind: 'image', status: 'error', summary: String(error) })
      } finally {
        if (actor.characterId) actorTasks.delete(lock)
      }
    }
    if (started)
      ctx.host.updateMessageMeta(message.id, { spriteGeneration: failed || signal.aborted ? 'error' : 'done' })
  } catch (error) {
    ctx.host.log({ chatId, kind: 'image', status: 'error', summary: String(error) })
  } finally {
    actorRuns.delete(chatId)
  }
}
