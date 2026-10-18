import { type QuickReply, type QuickReplySet, quickReplySetInput } from '@ai-parter/shared'
import { type CommandContext, requireChat, runCommandLine } from '../commands/run'
import { t } from '../i18n'

/** 顺序固定为全局、角色、会话；失效绑定和重复绑定都不会产生按钮。 */
export function mergeQuickReplySets(sets: QuickReplySet[], ...scopes: (string[] | undefined)[]): QuickReplySet[] {
  const ids = new Set(scopes.flatMap((s) => s ?? []))
  return [...ids].flatMap((id) => {
    const set = sets.find((s) => s.id === id)
    return set ? [set] : []
  })
}
export async function runQuickReply(qr: QuickReply, ctx: CommandContext, set?: QuickReplySet): Promise<string> {
  const input = ctx.getInput()
  let message = qr.message.replaceAll('{{input}}', input)
  if (set?.injectInput && input && !qr.message.includes('{{input}}')) {
    message = set.placeBeforeInput ? `${message} ${input}` : `${input} ${message}`
  }
  if (set?.disableSend) {
    ctx.setInput(message)
    return message
  }
  if (message.trimStart().startsWith('/')) return runCommandLine(message, ctx)
  await ctx.generate(requireChat(ctx), { mode: 'send', text: message, images: [] })
  return message
}
export type AutomationEvent = keyof QuickReply['autoExecute'] | 'automationId'
export function automationMatches(qr: QuickReply, event: AutomationEvent, ids: string[] = [], depth = 0): boolean {
  // 自动执行产生的事件至多向下一层传播，连同世界书触发一起阻断循环。
  if (depth >= 1) return false
  return event === 'automationId' ? !!qr.automationId && ids.includes(qr.automationId) : qr.autoExecute[event]
}

/** 接受酒馆 v2 的 qrList；其执行字段映射到本应用的显式事件结构。 */
export function importQuickReplySet(value: unknown): ReturnType<typeof quickReplySetInput.parse> {
  if (!value || typeof value !== 'object') throw new Error(t('快速回复集格式无效'))
  const raw = value as Record<string, unknown>
  const buttons = raw.buttons ?? raw.qrList
  return quickReplySetInput.parse({
    ...raw,
    buttons: Array.isArray(buttons)
      ? buttons.map((entry, index) => {
          if (!entry || typeof entry !== 'object') return entry
          const button = entry as Record<string, unknown>
          return {
            ...button,
            id: String(button.id ?? index),
            autoExecute: button.autoExecute ?? {
              onStartup: button.executeOnStartup,
              onUser: button.executeOnUser,
              onAi: button.executeOnAi,
              onChatChange: button.executeOnChatChange,
              onGroupMemberDraft: button.executeOnGroupMemberDraft,
              onNewChat: button.executeOnNewChat,
            },
          }
        })
      : buttons,
  })
}

/** 同一回复同时命中 onAi 和世界书 id 时只执行一次，隐藏按钮仍参与自动执行。 */
export async function runQuickReplyAutomation(
  sets: QuickReplySet[],
  event: AutomationEvent,
  ctx: CommandContext,
  ids: string[] = [],
  depth = 0,
) {
  for (const set of sets)
    for (const qr of set.buttons) {
      if (
        automationMatches(qr, event, ids, depth) ||
        (event === 'onAi' && automationMatches(qr, 'automationId', ids, depth))
      ) {
        await runQuickReply(qr, { ...ctx, automationDepth: depth + 1 }, set)
      }
    }
}

/** 世界书元数据是可选扩展字段，只接受字符串数组并去重。 */
export function loreAutomationIds(messages: { meta: unknown }[]): string[] {
  return [
    ...new Set(
      messages.flatMap((message) => {
        const meta = message.meta
        if (!meta || typeof meta !== 'object' || !('lore' in meta)) return []
        const lore = meta.lore
        if (!lore || typeof lore !== 'object' || !('automationIds' in lore) || !Array.isArray(lore.automationIds))
          return []
        return lore.automationIds.filter((id): id is string => typeof id === 'string')
      }),
    ),
  ]
}
