import type { GroupActivation } from '@nobot/shared'

/**
 * 群聊：决定这一轮由哪些角色发言（纯函数）。行为对照酒馆的 Group Chat 回复顺序。
 */

export interface GroupMemberInfo {
  id: string
  name: string
  muted: boolean
  /** 发言积极度 0–1 */
  talkativeness: number
}

export interface SpeakerSelectionInput {
  /** 按成员列表顺序 */
  members: GroupMemberInfo[]
  activation: GroupActivation
  allowSelfResponses: boolean
  /** 当前最后一条消息（用户刚发的，或上一条角色回复）；会话为空时为 null */
  lastMessage: { role: 'user' | 'assistant' | 'system' | 'tool'; speakerId: string | null; content: string } | null
  /** 自上一条用户消息以来已经发过言的角色 id（pooled 用） */
  spokenSinceUser: string[]
  /** true：用户刚发了消息；false：用户点了「让角色继续」（trigger） */
  userTriggered: boolean
  /** 强制发言的角色（「让 TA 说」），即使被静音也发言 */
  forcedSpeakerId?: string
  /** [0,1) 随机数，测试时注入固定序列 */
  random: () => number
}

/**
 * 返回这一轮依次发言的角色 id（可能为空数组）。规则：
 *
 * - forcedSpeakerId 存在且是成员：只返回 [forcedSpeakerId]
 * - 下面的「候选」都指没被静音的成员
 * - manual：userTriggered 为 true 时返回 []；否则从候选里随机返回一个
 * - list：按列表顺序返回全部候选
 * - pooled：从候选里还不在 spokenSinceUser 中的随机选一个；都说过了就从全部候选里随机选一个
 * - natural：
 *   1. 点名：在 lastMessage.content 里查找候选的名字（按全词匹配，规则同 worldinfo 的 matchKey，
 *      忽略大小写；名字含空格时拆成多个词，任一词命中即算点名），按在文本中首次出现的位置排序。
 *      lastMessage 的发言者本人不能被自己点名，除非 allowSelfResponses。
 *   2. 积极度：其余候选（排除 lastMessage 发言者，除非 allowSelfResponses）先用 random 打乱顺序，
 *      再逐个以 talkativeness 的概率（random() < talkativeness）加入。
 *   3. 结果去重；如果一个都没有，从候选里随机选一个（此时不排除上一位发言者，除非候选只剩他也照选）。
 * - 没有任何候选时返回 []
 */
export function selectSpeakers(input: SpeakerSelectionInput): string[] {
  // 强制规则优先于静音及激活模式，未知成员则回到普通选择流程。
  if (input.forcedSpeakerId !== undefined && input.members.some((member) => member.id === input.forcedSpeakerId)) {
    return [input.forcedSpeakerId]
  }
  const candidates = input.members.filter((member) => !member.muted)
  if (candidates.length === 0) return []
  const pick = (members: GroupMemberInfo[]): string[] => [members[Math.floor(input.random() * members.length)]!.id]
  if (input.activation === 'manual') return input.userTriggered ? [] : pick(candidates)
  if (input.activation === 'list') return candidates.map((member) => member.id)
  if (input.activation === 'pooled') {
    const unspoken = candidates.filter((member) => !input.spokenSinceUser.includes(member.id))
    return pick(unspoken.length > 0 ? unspoken : candidates)
  }

  // 自然模式第 1 条：全词边界与 matchKey 一致，保留匹配位置用于点名排序。
  const eligible = candidates.filter((member) => input.allowSelfResponses || member.id !== input.lastMessage?.speakerId)
  const text = input.lastMessage?.content ?? ''
  const mentions: { member: GroupMemberInfo; position: number }[] = []
  const remaining: GroupMemberInfo[] = []
  for (const member of eligible) {
    let position = Number.POSITIVE_INFINITY
    for (const word of member.name.trim().split(/\s+/).filter(Boolean)) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const match = new RegExp(`(^|\\W)${escaped}(?:$|\\W)`, 'i').exec(text)
      if (match) position = Math.min(position, match.index + match[1]!.length)
    }
    if (Number.isFinite(position)) mentions.push({ member, position })
    else remaining.push(member)
  }
  mentions.sort((a, b) => a.position - b.position)
  const chosen = mentions.map(({ member }) => member.id)

  // 自然模式第 2 条：用注入的随机数执行 Fisher–Yates 洗牌，再按积极度抽签。
  for (let i = remaining.length - 1; i > 0; i--) {
    const j = Math.floor(input.random() * (i + 1))
    const member = remaining[i]!
    remaining[i] = remaining[j]!
    remaining[j] = member
  }
  for (const member of remaining) {
    if (input.random() < member.talkativeness) chosen.push(member.id)
  }
  // 自然模式第 3 条：兜底允许上一位发言者；去重同时保留点名与抽签顺序。
  return chosen.length > 0 ? [...new Set(chosen)] : pick(candidates)
}
