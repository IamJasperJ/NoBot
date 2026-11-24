import { t } from '../../../../i18n'
import { loadPath } from '../../../../services/chats'
import { computeStage, resolvePlayPreset } from '../../../../services/generation/stage'
import { resolveImageConnection } from '../discovery'
import { parseSettings } from '../settings'
import { missingBackground } from './background'
import { generate } from './message'
import { errorText, validate } from './prompt'
import { backgroundTasks } from './state'
import type { Context } from './types'

export async function autoBackground(ctx: Context, chatId: string, messageId: string): Promise<void> {
  try {
    const play = resolvePlayPreset(chatId).data
    if (!play.directives.enabled || !play.stage.autoBackground) return
    const message = loadPath(messageId, 1)[0]
    if (
      message?.chatId !== chatId ||
      message.role !== 'assistant' ||
      message.status !== 'done' ||
      message.meta.error ||
      message.meta.toolCalls?.length ||
      !message.meta.stage?.ops.some((op) => op.op === 'scene' && op.bg?.trim())
    )
      return
    const stage = computeStage(chatId, loadPath(messageId))
    const bg = missingBackground(play, message, stage)
    if (!bg) return
    validate(resolveImageConnection(parseSettings(ctx.settings), false))
    const key = JSON.stringify([chatId, bg.toLowerCase()])
    if (backgroundTasks.has(key)) return
    backgroundTasks.set(key, chatId)
    try {
      await generate(ctx, {
        chatId,
        mode: 'background',
        backgroundName: bg,
        characterId: message.speakerId ?? undefined,
        historyLeafId: message.id,
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
