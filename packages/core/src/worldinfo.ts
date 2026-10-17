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
}

export interface ScanInput {
  entries: ScanEntry[]
  /** 聊天记录，从旧到新排列（调用方已去掉 system / tool 消息） */
  history: ScanMessage[]
  settings: WorldInfoSettings
  /** 当前生成类型，用于条目的 triggers 过滤 */
  type: GenerationType
  /** 当前发言角色的名字，用于条目的 characterFilter */
  characterName: string
  /** 额外匹配来源的文本（条目的 matchSources 引用它们） */
  sources: Partial<Record<MatchSource, string>>
  /** 仅参与首轮关键词扫描的虚拟文本，不计入历史深度，也不作为模型消息发送。 */
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
  reason: string
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
  if (opts.wholeWords && !trimmed.includes(' ')) {
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|\\W)${escaped}(?:$|\\W)`, opts.caseSensitive ? '' : 'i').test(text)
  }
  return opts.caseSensitive ? text.includes(trimmed) : text.toLowerCase().includes(trimmed.toLowerCase())
}

/**
 * 扫描世界书，返回要插入的条目。规则：
 *
 * 1. 候选条目：enabled 为 true；triggers 为空或包含 input.type；
 *    characterFilter.names 为空，或（exclude=false 时）包含 characterName、（exclude=true 时）不包含；
 *    history.length >= delay。position 为 outlet 但 outletName 为空的条目跳过。
 *    sticky / cooldown / groupScoring / automationId / vectorized 暂不生效（只保存）。
 *
 * 2. 扫描文本：每个条目单独计算 ——
 *    取最后 (entry.scanDepth ?? settings.scanDepth) 条消息，includeNames 时每条写成 "\x01名字: 内容"，
 *    否则只写内容，用 "\n" 连接；再拼上 scanText 和条目 matchSources 引用的 sources 文本；
 *    递归轮次里再拼上「递归缓冲区」（之前各轮被激活、且没有 preventRecursion 的条目内容）。
 *    scanDepth 为 0 时聊天记录部分为空（只能靠常驻、额外来源和递归触发）。
 *
 * 3. 激活判定（关键词和内容都先经过 input.macro）：
 *    - constant 为 true：直接激活，reason「常驻」
 *    - 否则任一主关键词匹配（matchKey，大小写和全词取条目设置 ?? 全局设置）
 *      且通过可选过滤：secondaryKeys 为空则通过；否则按 selectiveLogic ——
 *      and_any 至少一个匹配；and_all 全部匹配；not_any 全都不匹配；not_all 不是全部都匹配
 *    - 第 0 轮（非递归）：delayUntilRecursion 的条目不参与
 *    - 递归轮：excludeRecursion 的条目不参与；且只匹配递归缓冲区里的文本（reason 写「递归：关键词」）
 *
 * 4. 概率：useProbability 为 true 且 probability < 100 时，用 seed + 条目 id 生成的可复现随机数决定是否保留；
 *    没通过的记为 skipped「概率未命中」。
 *
 * 5. 包含组：每一轮激活后，按 group（逗号分隔，trim，可属于多个组）分组；同组有多个时只留一个：
 *    组里有 groupPrioritize 的条目时留 order 最大的；否则按 groupWeight 加权随机（同样用 seed）。
 *    被淘汰的记为 skipped「包含组：组名」。常驻条目也参与包含组。
 *
 * 6. 递归：settings.recursive 为 true 时，把本轮新激活条目里没有 preventRecursion 的内容加入递归缓冲区，
 *    进入下一轮，直到没有新激活或达到 maxRecursionSteps 轮（0 表示最多 10 轮）。
 *
 * 7. 预算：全部轮次结束后，按优先级「常驻优先，然后 order 降序」依次累加 countTokens(content)，
 *    超过 budget 的条目以及之后的所有条目都记为 skipped「超出预算」（预算用尽后不再插入任何条目）。
 *
 * 8. 排序（插入顺序）：来源优先级 chat → persona → 然后按 insertionStrategy：
 *    character_first：character → global；global_first：global → character；evenly：character 和 global 同级。
 *    同级内按 order 升序；order 相同按条目在输入数组中的顺序。
 *
 * report 里每个候选条目一条：activated 为 true 表示最终插入；否则 skippedReason 说明原因
 * （没匹配到关键词的条目也要列出，skippedReason「未命中关键词」，reason 为空字符串）。
 * 不满足候选条件（禁用、触发类型、角色过滤、延迟）的条目不列入 report。
 */
export function scanWorldInfo(input: ScanInput): ScanResult {
  const { settings } = input
  // 第 1 条：不符合候选条件的条目完全不进入报告。
  const candidates = input.entries.filter((entry) => {
    const filter = entry.characterFilter
    return (
      entry.enabled &&
      (entry.triggers.length === 0 || entry.triggers.includes(input.type)) &&
      (filter.names.length === 0 || filter.names.includes(input.characterName) !== filter.exclude) &&
      input.history.length >= entry.delay &&
      (entry.position !== 'outlet' || entry.outletName !== '')
    )
  })
  const report: WIActivation[] = candidates.map((entry) => ({
    entryId: entry.id,
    lorebookId: entry.lorebookId,
    lorebookName: entry.lorebookName,
    comment: entry.comment,
    position: entry.position,
    reason: '',
    activated: false,
    skippedReason: '未命中关键词',
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
  const recursiveRounds = settings.recursive ? settings.maxRecursionSteps || 10 : 0

  for (let round = 0; round <= recursiveRounds; round++) {
    const activated: Prepared[] = []
    const recursiveText = buffer.join('\n')
    for (const item of prepared) {
      const { entry, result } = item
      if (settled.has(item)) continue
      // 第 3 条：首轮延迟与禁止递归分别只影响对应轮次。
      if (round === 0 ? entry.delayUntilRecursion : entry.excludeRecursion) continue
      let reason = '常驻'
      if (!entry.constant) {
        let text = recursiveText
        if (round === 0) {
          // 第 2 条：按每个条目的深度缓存聊天文本；深度为 0 不能用 slice(-0)。
          const depth = entry.scanDepth ?? settings.scanDepth
          let historyText = historyByDepth.get(depth)
          if (historyText === undefined) {
            historyText = (depth === 0 ? [] : input.history.slice(-depth))
              .map((message) => (settings.includeNames ? `\x01${message.name}: ${message.content}` : message.content))
              .join('\n')
            historyByDepth.set(depth, historyText)
          }
          text = [
            historyText,
            ...(input.scanText ? [input.scanText] : []),
            ...entry.matchSources.map((source) => input.sources[source] ?? ''),
          ].join('\n')
        }
        // 第 3 条：递归轮只匹配缓冲区；主关键词与可选过滤使用同一匹配设置。
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
        reason = `${round === 0 ? '关键词' : '递归'}：${key}`
      }
      result.reason = reason
      // 第 4 条：每个条目使用固定种子，失败后不在后续轮次重复抽签。
      settled.add(item)
      if (
        entry.useProbability &&
        entry.probability < 100 &&
        seededRandom(hashString(`${input.seed}|${entry.id}`))() >= entry.probability / 100
      ) {
        result.skippedReason = '概率未命中'
        continue
      }
      activated.push(item)
    }

    // 第 5 条：按输入顺序处理包含组；多组条目被任一组淘汰后不再参加后续组。
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
      const competing = members.filter((item) => survivors.has(item))
      if (competing.length < 2) continue
      let winner = competing[0]!
      if (competing.some((item) => item.entry.groupPrioritize)) {
        for (const item of competing) {
          if (item.entry.order > winner.entry.order) winner = item
        }
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
        item.result.skippedReason = `包含组：${group}`
      }
    }
    // 第 6 条：只有本轮实际保留且允许传播的内容能进入后续轮次的缓冲区。
    if (survivors.size === 0) break
    for (const item of survivors) {
      selected.push(item)
      if (!item.entry.preventRecursion) buffer.push(item.content)
    }
  }

  // 第 7 条：先常驻，再按 order 降序；遇到首个超预算条目后永久停止插入。
  selected.sort(
    (a, b) => Number(b.entry.constant) - Number(a.entry.constant) || b.entry.order - a.entry.order || a.index - b.index,
  )
  let used = 0
  let exhausted = false
  const inserted: Prepared[] = []
  for (const item of selected) {
    const tokens = exhausted ? 0 : input.countTokens(item.content)
    if (exhausted || used + tokens > input.budget) {
      exhausted = true
      item.result.skippedReason = '超出预算'
      continue
    }
    used += tokens
    item.result.activated = true
    item.result.tokens = tokens
    delete item.result.skippedReason
    inserted.push(item)
  }

  // 第 8 条：来源同级时统一比较 order，相同 order 保持输入顺序。
  const rank: Record<LoreSource, number> = {
    chat: 0,
    persona: 1,
    character: settings.insertionStrategy === 'global_first' ? 3 : 2,
    global: settings.insertionStrategy === 'character_first' ? 3 : 2,
  }
  inserted.sort(
    (a, b) => rank[a.entry.source] - rank[b.entry.source] || a.entry.order - b.entry.order || a.index - b.index,
  )
  return {
    activated: inserted.map(({ entry, content, result }) => ({
      entry,
      content,
      reason: result.reason,
      tokens: result.tokens,
    })),
    report,
  }
}
