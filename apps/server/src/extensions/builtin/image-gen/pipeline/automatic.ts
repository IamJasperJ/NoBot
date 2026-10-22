import { t } from '../../../../i18n'
import { getChatRow, loadPath } from '../../../../services/chats'
import { computeStage, resolvePlayPreset } from '../../../../services/stage'
import { resolveImageConnection } from '../discovery'
import { parseSettings } from '../settings'
import { missingBackground } from './background'
import { generate } from './message'
import { errorText, validate } from './prompt'
import { backgroundTasks } from './state'
import type { Context } from './types'

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
