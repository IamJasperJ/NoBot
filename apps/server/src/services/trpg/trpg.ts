import type { CheckInput } from '@nobot/core/stage'
import { castKey, getRuleSystem } from '@nobot/core/stage'
import { HttpError } from '../../errors'
import { t } from '../../i18n'
import { computeVars, getChatRow, loadPath } from '../chats'
import { resolvePersona } from '../generation/context'
import { initialVars, matchStageMember, resolvePlayPreset, stageMembers } from '../generation/stage'
import { readSheet } from './trpg-sheet'

export function chatRules(chatId: string) {
  const { data } = resolvePlayPreset(chatId)
  return data.directives.enabled ? getRuleSystem(data.trpg.ruleSystem) : null
}

/** 与舞台演员共用 castKey；玩家永远使用 player 前缀，不受显示名变化影响。 */
export function resolveWho(chatId: string, who = 'player') {
  const persona = resolvePersona(getChatRow(chatId))
  const key = castKey(who)
  if (['player', 'me', 'myself', 'user', '我', '玩家', castKey(persona.name)].includes(key)) {
    return { name: persona.name, prefix: 'player', sheet: persona.sheet, characterId: null }
  }
  const member = matchStageMember(chatId, who)
  return member
    ? { name: member.name, prefix: member.name, sheet: readSheet(member.extensions), characterId: member.id }
    : { name: who.trim(), prefix: who.trim(), sheet: null, characterId: null }
}

export function performCheck(
  chatId: string,
  input: Omit<CheckInput, 'who'> & { who?: string },
  vars?: Record<string, unknown>,
  random: () => number = Math.random,
  actorOverride?: ReturnType<typeof resolveWho>,
) {
  const rules = chatRules(chatId)
  if (!rules) throw new HttpError(400, 'TRPG_DISABLED', t('当前会话未启用受支持的跑团规则'))
  const actor = actorOverride ?? resolveWho(chatId, input.who)
  const current = vars ?? computeVars(loadPath(getChatRow(chatId).activeLeafId), initialVars(chatId).vars)
  const result = rules.check(
    { ...input, who: actor.prefix },
    actor.sheet,
    current,
    { crit: resolvePlayPreset(chatId).data.trpg.critRules },
    random,
  )
  return { ...result, who: actor.name }
}

/** 提示词只读摘要，不改变属性卡或会话变量。 */
export function describeParty(chatId: string, vars: Record<string, unknown>) {
  const rules = chatRules(chatId)
  if (!rules) return ''
  return ['player', ...stageMembers(chatId).map((row) => row.name)]
    .map((who) => resolveWho(chatId, who))
    .filter((actor) => actor.sheet !== null)
    .map((actor) => rules.describe(actor.prefix, actor.sheet!, vars))
    .join('\n\n')
}
