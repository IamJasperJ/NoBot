import type { BackgroundDTO, LorebookEntryData, WIActivation } from '@nobot/shared'
import { eq } from 'drizzle-orm'
import { db } from '../../db/client'
import { backgrounds, type ChatRow } from '../../db/schema'
import { HttpError } from '../../errors'
import { t } from '../../i18n'
import { getChatRow, loadPath, updateChat } from '../chats'
import { quietPrompt } from '../generation/quiet-prompt'
import { logError } from '../logs'
import { matchBackground } from './background-match'
import { backgroundsForChat, findBackgroundForChat } from './backgrounds'

export async function autoSelectBackground(chatId: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const list = backgroundCandidates(chatId)
  const chat = getChatRow(chatId)
  const { backgroundId, reply } = await chooseBackground(chat, list, signal)
  if (!sameBackgroundContext(chat, getChatRow(chatId))) {
    throw new HttpError(409, 'BACKGROUND_CONTEXT_CHANGED', t('会话分支或背景已变化，请重新选择背景'))
  }
  const background = findBackgroundForChat(chatId, backgroundId)
  if (!background) {
    throw new HttpError(409, 'BACKGROUND_UNAVAILABLE', t('模型选中的背景已不可用，请重新选择背景'))
  }
  updateChat(chatId, { backgroundId })
  return { background, reply }
}

function backgroundCandidates(chatId: string) {
  const list = backgroundsForChat(chatId)
  if (!list.length) throw new HttpError(400, 'EMPTY_BACKGROUNDS', t('背景库是空的'))
  return list
}

/** 手动与定期选择在请求开始时固定会话分支，由各自的调用方决定是否应用结果。 */
async function chooseBackground(chat: ChatRow, list: BackgroundDTO[], signal?: AbortSignal) {
  const reply = await quietPrompt({
    chatId: chat.id,
    leafId: chat.activeLeafId,
    instruction: `Ignore previous format requirements. Select the location from the following list that best fits the current scene. Output only its exact name from the list, with no other text:\n${list.map((b) => `- ${b.name}：${b.description}`).join('\n')}`,
    signal,
  })
  signal?.throwIfAborted()
  const background = matchBackground(list, reply)
  if (!background) throw new HttpError(400, 'EMPTY_REPLY', t('模型没有选择背景'))
  return { backgroundId: background.id, reply }
}

function sameBackgroundContext(before: ChatRow, current: ChatRow) {
  return (
    before.activeLeafId === current.activeLeafId &&
    before.backgroundId === current.backgroundId &&
    before.backgroundPinned === current.backgroundPinned
  )
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

/** 同轮优先应用世界书绑定，迟到的选择不会覆盖等待期间设置的背景。 */
export async function applyAutomaticBackground(
  chatId: string,
  messageId: string,
  loreId: string | null,
  countReply: boolean,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return
  const chat = getChatRow(chatId)
  if (chat.activeLeafId !== messageId) return
  const { lore, everyN } = chat.autoBackground
  let selectedId: string | undefined
  if (countReply && everyN > 0) {
    const count = backgroundReplyCount(loadPath(chat.activeLeafId))
    if (count > 0 && count % everyN === 0) {
      try {
        selectedId = (await chooseBackground(chat, backgroundCandidates(chatId), signal)).backgroundId
      } catch (error) {
        if (signal?.aborted) return
        logError(t('自动选择背景失败'), error)
      }
    }
  }
  if (!selectedId && !(lore && loreId)) return
  if (signal?.aborted) return
  const current = getChatRow(chatId)
  if (
    !sameBackgroundContext(chat, current) ||
    current.autoBackground.everyN !== everyN ||
    current.autoBackground.lore !== lore
  )
    return
  // 生成期间可删除背景，应用前重新检查，避免失效外键打断正常生成。
  // 条目是用户显式绑定，允许像手动设置一样引用任意背景；模型自动选择仍限定会话范围。
  if (lore && loreId && db.select({ id: backgrounds.id }).from(backgrounds).where(eq(backgrounds.id, loreId)).get()) {
    updateChat(chatId, { backgroundId: loreId })
  } else if (selectedId && findBackgroundForChat(chatId, selectedId)) {
    updateChat(chatId, { backgroundId: selectedId })
  }
}
