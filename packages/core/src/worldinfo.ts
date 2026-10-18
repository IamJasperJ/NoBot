import type { GenerationType, LorebookEntryData, MatchSource, WIActivation, WorldInfoSettings } from '@ai-parter/shared'
import { hashString, seededRandom } from './prompt/macros'

/**
 * 世界书扫描引擎（纯函数，不读数据库、不发请求）。
 *
 * 行为对照酒馆（SillyTavern）的 World Info，规则见下方 scanWorldInfo 的说明。
 */

/** 条目来自哪里挂载的世界书 */
export type LoreSource = 'chat' | 'persona' | 'character' | 'global'

export interface ScanEntry extends LorebookEntryData {
  id: string
  lorebookId: string
  lorebookName: string
  source: LoreSource
}

/** 参与扫描的一条聊天消息 */
export interface ScanMessage {
  /** 发言人名字（includeNames 时作为前缀） */
  name: string
  content: string
  activated?: string[]
}

export interface ScanInput {
  entries: ScanEntry[]
  vectorMatches?: readonly string[]
  activationHistory?: readonly { activated?: readonly string[] }[]
  /** 聊天记录，从旧到新排列（调用方已去掉 system / tool 消息） */
  history: ScanMessage[]
  settings: WorldInfoSettings
  /** 当前生成类型，用于条目的 triggers 过滤 */
  type: GenerationType
  /** 当前发言角色的名字，用于条目的 characterFilter */
  characterName: string
  /** 额外匹配来源的文本（条目的 matchSources 引用它们） */
  sources: Partial<Record<MatchSource, string>>
  /** 注入扫描缓冲区的虚拟文本，不计入历史深度，也不作为模型消息发送。 */
  scanText?: string
  /** 世界书可用的 token 预算，调用方已按 settings 和上下文长度算好 */
  budget: number
  /** 随机种子：概率和包含组的随机结果只由它决定，保证预览与真实发送一致 */
  seed: string
  /** 宏替换，作用于关键词和条目内容 */
  macro: (text: string) => string
  countTokens: (text: string) => number
}

export interface ActivatedEntry {
  entry: ScanEntry
  /** 宏替换后的内容 */
  content: string
  /** 触发原因，如「常驻」「关键词：龙」「递归：龙」 */
  reasonCode: WIActivation['reasonCode']
  reasonParams?: WIActivation['reasonParams']
  tokens: number
}

export interface ScanResult {
  /**
   * 最终插入的条目，已按插入顺序排好：
   * 先按来源（由 insertionStrategy 决定，见下），同来源内按 order 升序（数字大的更靠后）。
   */
  activated: ActivatedEntry[]
  /** 所有参与扫描的条目的结果（含没插入的原因），给 Prompt 预览用 */
  report: WIActivation[]
  automationIds: string[]
}

/**
 * 判断一个关键词是否出现在文本里。
 * - 形如 /pattern/flags 的关键词按 JS 正则匹配（flags 原样使用；正则写错时当作不匹配，不抛异常）
 * - 否则按普通文本：caseSensitive 为 false 时忽略大小写；
 *   wholeWords 为 true 且关键词不含空格时，要求前后是文本边界或非单词字符
 *   （用 (?:^|\W)关键词(?:$|\W)，中文字符属于 \W，所以中文关键词等同于子串匹配）
 * - 关键词前后空白要 trim，空关键词永远不匹配
 */
export function matchKey(key: string, text: string, opts: { caseSensitive: boolean; wholeWords: boolean }): boolean {
  const trimmed = key.trim()
  if (!trimmed) return false
  const regex = trimmed.match(/^\/(.+)\/([a-z]*)$/s)
  if (regex) {
    try {
      return new RegExp(regex[1]!, regex[2]).test(text)
    } catch {
      return false
    }
  }

  // 关键词规则：含空格的短语不加边界，普通关键词须转义，避免被当成正则。
  if (opts.wholeWords && !/\s/.test(trimmed)) {
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|\\W)${escaped}(?:$|\\W)`, opts.caseSensitive ? '' : 'i').test(text)
  }
  return opts.caseSensitive ? text.includes(trimmed) : text.toLowerCase().includes(trimmed.toLowerCase())
}

/** 扫描时逐轮结算包含组、概率和预算，只有插入成功的内容参与递归。 */
export function scanWorldInfo(input: ScanInput): ScanResult {
  const { settings } = input
  const candidates = input.entries.filter((entry) => {
    const filter = entry.characterFilter
    return (
      entry.enabled &&
      (entry.triggers.length === 0 || entry.triggers.includes(input.type)) &&
      (filter.names.length === 0 || filter.names.includes(input.characterName) !== filter.exclude) &&
      (input.activationHistory?.length ?? input.history.length) >= entry.delay &&
      (entry.position !== 'outlet' || entry.outletName !== '')
    )
  })
  const report: WIActivation[] = candidates.map((entry) => ({
    entryId: entry.id,
    lorebookId: entry.lorebookId,
    lorebookName: entry.lorebookName,
    comment: entry.comment,
    position: entry.position,
    reasonCode: 'none',
    activated: false,
    dropped: false,
    skippedCode: 'no_match',
    tokens: 0,
  }))
  const prepared = candidates.map((entry, index) => ({
    entry,
    index,
    keys: entry.keys.map(input.macro),
    secondaryKeys: entry.secondaryKeys.map(input.macro),
    content: input.macro(entry.content),
    result: report[index]!,
  }))
  type Prepared = (typeof prepared)[number]
  const settled = new Set<Prepared>()
  const selected: Prepared[] = []
  const historyByDepth = new Map<number, string>()
  const buffer: string[] = []
  const timed = new Map(
    candidates.map((entry) => [entry.id, timedEffect(entry, input.activationHistory ?? input.history)]),
  )
  const recursiveRounds = settings.recursive ? settings.maxRecursionSteps || Number.POSITIVE_INFINITY : 0
  let recursionSteps = 0
  let depth = settings.scanDepth
  let state: 'initial' | 'recursive' | 'minimum' = 'initial'
  const rank: Record<LoreSource, number> = {
    chat: 0,
    persona: 1,
    character: settings.insertionStrategy === 'global_first' ? 3 : 2,
    global: settings.insertionStrategy === 'character_first' ? 3 : 2,
  }
  let delayedScanPending = candidates.some((entry) => entry.delayUntilRecursion)
  let usedText = ''
  let exhausted = false

  for (let round = 0; ; round++) {
    if (state === 'recursive') delayedScanPending = false
    const activated: Prepared[] = []
    const recursiveText = buffer.join('\n')
    // 关键词判定与组内评分必须读取完全相同的缓冲区；补扫时暂不包含递归文本。
    const textFor = (entry: ScanEntry) => {
      const scanDepth = entry.scanDepth ?? depth
      let historyText = historyByDepth.get(scanDepth)
      if (historyText === undefined) {
        historyText = (scanDepth === 0 ? [] : input.history.slice(-scanDepth))
          .map((message) => `\x01${settings.includeNames ? `${message.name}: ` : ''}${message.content.trim()}`)
          .join('\n')
        historyByDepth.set(scanDepth, historyText)
      }
      return [
        historyText,
        ...(input.scanText ? [input.scanText] : []),
        ...entry.matchSources.map((source) => input.sources[source] ?? ''),
        ...(state === 'recursive' ? [recursiveText] : []),
      ].join('\n')
    }
    for (const item of prepared) {
      const { entry, result } = item
      if (settled.has(item)) continue
      const effect = timed.get(entry.id)!
      if (effect.cooldown && !effect.sticky) {
        result.skippedCode = 'cooldown'
        continue
      }
      if (!effect.sticky && (state !== 'recursive' ? entry.delayUntilRecursion : entry.excludeRecursion)) {
        if (entry.delayUntilRecursion && state !== 'recursive') result.skippedCode = 'delay'
        continue
      }
      if (result.skippedCode === 'delay') result.skippedCode = 'no_match'
      let reason: WIActivation['reasonCode'] = 'constant'
      if (effect.sticky) reason = 'sticky'
      else if (entry.vectorized && input.vectorMatches?.includes(entry.id)) reason = 'vector'
      else if (!entry.constant) {
        const text = textFor(entry)
        const opts = {
          caseSensitive: entry.caseSensitive ?? settings.caseSensitive,
          wholeWords: entry.matchWholeWords ?? settings.matchWholeWords,
        }
        const key = item.keys.find((key) => matchKey(key, text, opts))
        if (key === undefined) continue
        const secondary = item.secondaryKeys.map((key) => matchKey(key, text, opts))
        if (secondary.length > 0) {
          const passes = {
            and_any: secondary.some(Boolean),
            and_all: secondary.every(Boolean),
            not_any: !secondary.some(Boolean),
            not_all: !secondary.every(Boolean),
          }[entry.selectiveLogic]
          if (!passes) continue
        }
        reason = state === 'recursive' ? 'recursive' : 'keyword'
        result.reasonParams = { key }
      }
      result.reasonCode = reason
      activated.push(item)
    }

    const groups = new Map<string, Prepared[]>()
    for (const item of activated) {
      for (const group of new Set(
        item.entry.group
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
      )) {
        const members = groups.get(group) ?? []
        members.push(item)
        groups.set(group, members)
      }
    }
    const survivors = new Set(activated)
    for (const [group, members] of groups) {
      let competing = members.filter((item) => survivors.has(item))
      const remove = (item: Prepared) => {
        survivors.delete(item)
        item.result.skippedCode = 'group'
        item.result.skippedParams = { group }
      }
      const sticky = competing.filter((item) => timed.get(item.entry.id)!.sticky)
      if (sticky.length) {
        for (const item of competing) if (!sticky.includes(item)) remove(item)
        continue
      }
      if (
        selected.some((item) =>
          item.entry.group
            .split(',')
            .map((name) => name.trim())
            .includes(group),
        )
      ) {
        for (const item of competing) remove(item)
        continue
      }
      const scores = competing.map((item) => {
        const entry = item.entry
        const text = textFor(entry)
        const opts = {
          caseSensitive: entry.caseSensitive ?? settings.caseSensitive,
          wholeWords: entry.matchWholeWords ?? settings.matchWholeWords,
        }
        const primary = item.keys.filter((key) => matchKey(key, text, opts)).length
        const secondary = item.secondaryKeys.filter((key) => matchKey(key, text, opts)).length
        return item.keys.length
          ? primary +
              (entry.selectiveLogic === 'and_any' ||
              (entry.selectiveLogic === 'and_all' && secondary === item.secondaryKeys.length)
                ? secondary
                : 0)
          : 0
      })
      const maxScore = Math.max(...scores)
      competing.forEach((item, index) => {
        if (item.entry.groupScoring && scores[index]! < maxScore) remove(item)
      })
      competing = competing.filter((item) => survivors.has(item))
      if (competing.length < 2) continue
      let winner = competing[0]!
      if (competing.some((item) => item.entry.groupPrioritize)) {
        winner = competing
          .filter((item) => item.entry.groupPrioritize)
          .sort((a, b) => b.entry.order - a.entry.order)[0]!
      } else {
        const total = competing.reduce((sum, item) => sum + item.entry.groupWeight, 0)
        let draw = seededRandom(hashString(`${input.seed}|group|${round}|${group}`))() * total
        for (const item of competing) {
          draw -= item.entry.groupWeight
          if (draw < 0) {
            winner = item
            break
          }
        }
      }
      for (const item of competing) {
        if (item === winner) continue
        survivors.delete(item)
        item.result.skippedCode = 'group'
        item.result.skippedParams = { group }
      }
    }
    const ordered = [...survivors].sort(
      (a, b) =>
        Number(timed.get(b.entry.id)!.sticky) - Number(timed.get(a.entry.id)!.sticky) ||
        rank[a.entry.source] - rank[b.entry.source] ||
        b.entry.order - a.entry.order ||
        a.index - b.index,
    )
    let propagated = false
    for (const item of ordered) {
      const { entry, result } = item
      settled.add(item)
      if (
        !timed.get(entry.id)!.sticky &&
        entry.useProbability &&
        seededRandom(hashString(`${input.seed}|${entry.id}`))() >= entry.probability / 100
      ) {
        result.skippedCode = 'probability'
        continue
      }
      result.tokens = input.countTokens(item.content)
      const next = `${usedText}${item.content}\n`
      if (exhausted || input.countTokens(next) >= input.budget) {
        exhausted = true
        result.skippedCode = 'budget'
        result.dropped = true
        continue
      }
      usedText = next
      selected.push(item)
      result.activated = true
      delete result.skippedCode
      delete result.skippedParams
      if (!entry.preventRecursion) {
        buffer.push(item.content)
        propagated = true
      }
    }
    if (exhausted) break
    if (
      settings.recursive &&
      recursionSteps < recursiveRounds &&
      (propagated || (state === 'minimum' && buffer.length > 0))
    ) {
      state = 'recursive'
      recursionSteps++
      continue
    }
    if (
      selected.length < settings.minActivations &&
      depth < Math.min(settings.maxDepth || input.history.length, input.history.length)
    ) {
      depth++
      state = 'minimum'
      continue
    }
    if (delayedScanPending && settings.recursive && recursionSteps < recursiveRounds) {
      delayedScanPending = false
      state = 'recursive'
      recursionSteps++
      continue
    }
    break
  }
  const inserted = selected

  inserted.sort(
    (a, b) => rank[a.entry.source] - rank[b.entry.source] || a.entry.order - b.entry.order || a.index - b.index,
  )
  return {
    activated: inserted.map(({ entry, content, result }) => ({
      entry,
      content,
      reasonCode: result.reasonCode,
      ...(result.reasonParams ? { reasonParams: result.reasonParams } : {}),
      tokens: result.tokens,
    })),
    report,
    automationIds: [...new Set(inserted.map(({ entry }) => entry.automationId.trim()).filter(Boolean))],
  }
}

/** 重放激活路径；粘滞期间的重复激活不续期，冷却从粘滞结束后计算。 */
export function timedEffect(
  entry: Pick<ScanEntry, 'id' | 'sticky' | 'cooldown'>,
  history: readonly { activated?: readonly string[] }[],
) {
  let start = -1
  for (let index = 0; index < history.length; index++) {
    if (!history[index]?.activated?.includes(entry.id)) continue
    if (start < 0 || index >= start + entry.sticky + entry.cooldown) start = index
  }
  const distance = history.length - start
  return {
    sticky: start >= 0 && distance < entry.sticky,
    cooldown: start >= 0 && distance >= entry.sticky && distance < entry.sticky + entry.cooldown,
  }
}

/** 余弦相似度只处理有限且维度一致的向量，零向量视为未命中。 */
export function vectorMatches(
  entries: readonly { id: string; vector: number[] }[],
  query: number[],
  threshold: number,
  limit: number,
): string[] {
  return entries
    .map(({ id, vector }) => {
      const dot = vector.reduce((sum, value, index) => sum + value * (query[index] ?? 0), 0)
      const norm = Math.sqrt(
        vector.reduce((sum, value) => sum + value * value, 0) * query.reduce((sum, value) => sum + value * value, 0),
      )
      const score = vector.length === query.length && norm > 0 ? dot / norm : 0
      return { id, score }
    })
    .filter(({ score }) => Number.isFinite(score) && score > threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ id }) => id)
}
