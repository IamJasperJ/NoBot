import type { LorebookEntryData, WIActivation } from '@nobot/shared'
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { backgrounds } from '../../db/schema'
import { HttpError } from '../../errors'
import { t } from '../../i18n'
import { getChatRow, loadPath, updateChat } from '../chats'
import { quietPrompt } from '../generation/quiet-prompt'
import { logError } from '../logs'
import { matchBackground } from './background-match'
import { backgroundsForChat } from './backgrounds'

/** 手动与定期自动选择使用相同的候选范围、静默提示词和匹配规则。 */
export async function autoSelectBackground(chatId: string) {
  const list = backgroundsForChat(chatId)
  if (!list.length) throw new HttpError(400, 'EMPTY_BACKGROUNDS', t('背景库是空的'))
  const reply = await quietPrompt({
    chatId,
    instruction: `Ignore previous format requirements. Select the location from the following list that best fits the current scene. Output only its exact name from the list, with no other text:\n${list.map((b) => `- ${b.name}：${b.description}`).join('\n')}`,
  })
  const background = matchBackground(list, reply)
  if (!background) throw new HttpError(400, 'EMPTY_REPLY', t('模型没有选择背景'))
  updateChat(chatId, { backgroundId: background.id })
  return { background, reply }
}

/** 只使用最终激活的条目，预算淘汰、概率失败等候选不能触发换背景；同 order 保持扫描顺序。 */
export function loreBackgroundId(
  report: WIActivation[],
  entries: (Pick<LorebookEntryData, 'backgroundId' | 'order'> & { id: string })[],
): string | null {
  const activated = new Set(report.filter((item) => item.activated).map((item) => item.entryId))
  return (
    entries.filter((entry) => entry.backgroundId && activated.has(entry.id)).sort((a, b) => b.order - a.order)[0]
      ?.backgroundId ?? null
  )
}

/** 按当前分支的成功角色回复计数；开场白无生成日志，工具调用轮次也不算角色回复。 */
export function backgroundReplyCount(path: ReturnType<typeof loadPath>): number {
  return path.filter(
    (message) =>
      message.role === 'assistant' &&
      message.status === 'done' &&
      message.meta.logId &&
      !message.meta.toolCalls?.length,
  ).length
}

/** 背景选择失败不应把已完成的角色回复标记成失败；世界书明确绑定的背景在同轮定期选择之后应用。 */
export async function applyAutomaticBackground(chatId: string, loreId: string | null, countReply: boolean) {
  const chat = getChatRow(chatId)
  const { lore, everyN } = chat.autoBackground
  if (countReply && everyN > 0) {
    const count = backgroundReplyCount(loadPath(chat.activeLeafId))
    if (count > 0 && count % everyN === 0) {
      try {
        await autoSelectBackground(chatId)
      } catch (error) {
        logError(t('自动选择背景失败'), error)
      }
    }
  }
  // 生成期间可删除背景，应用前重新检查，避免失效外键打断正常生成。
  // 条目是用户显式绑定，允许像手动设置一样引用任意背景；模型自动选择仍限定会话范围。
  if (lore && loreId && db.select({ id: backgrounds.id }).from(backgrounds).where(eq(backgrounds.id, loreId)).get()) {
    updateChat(chatId, { backgroundId: loreId })
  }
}
