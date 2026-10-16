import type { CharacterExtras, CharacterFields, LorebookEntryData, PresetData } from '@ai-parter/shared'

/**
 * 与酒馆（SillyTavern）文件格式互转。全部是纯函数：输入 JSON 对象，输出我们的内部格式，反之亦然。
 * 导入时要宽容：缺字段用默认值，类型不对的字段忽略；只有结构完全不对时才抛 STFormatError。
 * 导入结果必须再经过对应 zod schema 的 parse（presetDataSchema / lorebookEntryDataSchema）补齐默认值。
 */

export { STFormatError } from './utils'

import * as card from './card'
import * as preset from './preset'
import * as worldinfo from './worldinfo'

// ---------------------------------------------------------------------------
// 生成预设（酒馆 Chat Completion 预设 JSON）
//
// 采样参数字段映射：
//   temperature → samplers.temperature        frequency_penalty → frequencyPenalty
//   presence_penalty → presencePenalty        top_p → topP     top_k → topK     top_a → topA
//   min_p → minP       repetition_penalty → repetitionPenalty
//   openai_max_context → contextSize          openai_max_tokens → maxTokens
//   stream_openai → stream     seed → seed    n → n
//   function_calling → functionCalling        show_thoughts → requestReasoning
//   reasoning_effort（auto/min/low/medium/high/max）→ reasoningEffort（min→minimal，max→high）
//   enable_web_search → webSearch             image_inlining → inlineImages
// 行为：
//   names_behavior（-1 none / 0 default / 1 completion / 2 content）→ behavior.namesBehavior
//   continue_prefill → continuePrefill        continue_postfix → continuePostfix（只接受 ''、' '、'\n'、'\n\n'）
//   squash_system_messages → squashSystem     wrap_in_quotes → wrapInQuotes
//   custom_prompt_post_processing（''/merge/semi/strict/single）→ postProcessing（none/merge/semi_strict/strict/single_user）
//   assistant_prefill → assistantPrefill      assistant_impersonation → assistantImpersonationPrefill
//   claude_use_sysprompt → useSystemPrompt
// 辅助提示词：
//   wi_format → worldInfoFormat   scenario_format → scenarioFormat   personality_format → personalityFormat
//   group_nudge_prompt → groupNudge   new_chat_prompt → newChat   new_group_chat_prompt → newGroupChat
//   new_example_chat_prompt → newExampleChat   continue_nudge_prompt → continueNudge
//   impersonation_prompt → impersonation   send_if_empty → sendIfEmpty
//
// Prompt 条目：prompts 数组里每项 { identifier, name, role, content, marker, system_prompt,
//   injection_position（0 相对 / 1 聊天内）, injection_depth, injection_order, injection_trigger[], enabled }。
//   顺序和开关来自 prompt_order：取 character_id 为 100001 的那组，没有就取 100000，再没有取第一组；
//   order 数组里每项 { identifier, enabled }，enabled 以 order 里的为准。
//   出现在 prompts 但不在 order 里的条目追加到末尾并设为 enabled: false；
//   order 里引用了 prompts 中不存在的 identifier 时：若是内置标识则用默认内容生成，否则忽略。
// 内置标识映射（酒馆 → 我们）：
//   main→main  nsfw→auxiliary  jailbreak→post_history  enhanceDefinitions→enhance_definitions
//   worldInfoBefore→wi_before  worldInfoAfter→wi_after  charDescription→char_description
//   charPersonality→char_personality  scenario→scenario  personaDescription→persona
//   dialogueExamples→examples  chatHistory→history
//   其他 identifier（通常是 uuid）视为自定义条目，id 保持不变。
//   injection_trigger 里的值与我们的 GenerationType 同名，未知值丢弃。
// ---------------------------------------------------------------------------

export function importSTPreset(json: unknown): PresetData {
  return preset.importSTPreset(json)
}

/** 反向映射，导出的 JSON 能被酒馆直接导入（prompt_order 写成 character_id 100001 一组） */
export function exportSTPreset(data: PresetData): Record<string, unknown> {
  return preset.exportSTPreset(data)
}

// ---------------------------------------------------------------------------
// 世界书
//
// 支持两种输入：
// A. 酒馆世界书文件：{ entries: { "0": {...}, "1": {...} } }（对象，按 displayIndex 或键的数字顺序排序）
//    条目字段：key[] → keys   keysecondary[] → secondaryKeys   comment   content   constant
//    selectiveLogic（0 and_any / 1 not_all / 2 not_any / 3 and_all）   order   depth   probability   useProbability
//    position（0 before_char / 1 after_char / 2 before_an / 3 after_an / 4 at_depth / 5 before_em / 6 after_em / 7 outlet）
//    disable（取反为 enabled）  excludeRecursion  preventRecursion  delayUntilRecursion
//    group  groupOverride → groupPrioritize  groupWeight  useGroupScoring → groupScoring
//    scanDepth / caseSensitive / matchWholeWords（null 表示继承）
//    role（0 system / 1 user / 2 assistant，null 视为 system）  sticky  cooldown  delay  automationId  vectorized
//    characterFilter { isExclude, names[] } → { exclude, names }   triggers[]   outletName
//    matchCharacterDescription / matchCharacterPersonality / matchScenario / matchPersonaDescription /
//    matchCharacterDepthPrompt / matchCreatorNotes → matchSources
//      （char_description / char_personality / scenario / persona / char_note / creator_notes）
// B. 角色卡内嵌的 character_book：{ name?, entries: [...] }（数组）
//    条目字段：keys  secondary_keys  content  enabled  insertion_order → order  constant  comment（没有时用 name）
//    case_sensitive  selective  position（'before_char' | 'after_char'）
//    extensions 里有与 A 类似的字段（下划线命名）：position（数字，优先于外层字符串）、depth、probability、
//    useProbability、selectiveLogic、exclude_recursion、prevent_recursion、delay_until_recursion、
//    match_whole_words、case_sensitive、group、group_override、group_weight、scan_depth、role、
//    sticky、cooldown、delay、automation_id、vectorized
// ---------------------------------------------------------------------------

export function importSTWorldInfo(json: unknown): { name: string | null; entries: LorebookEntryData[] } {
  return worldinfo.importSTWorldInfo(json)
}

/** 导出为酒馆世界书文件格式（A），uid 和对象键用下标 */
export function exportSTWorldInfo(entries: LorebookEntryData[]): Record<string, unknown> {
  return worldinfo.exportSTWorldInfo(entries)
}

/** 转成角色卡内嵌的 character_book 格式（B），字段放在外层和 extensions 两处，保证酒馆能读回 */
export function toCharacterBook(name: string, entries: LorebookEntryData[]): Record<string, unknown> {
  return worldinfo.toCharacterBook(name, entries)
}

// ---------------------------------------------------------------------------
// 角色卡导出
// ---------------------------------------------------------------------------

export interface CardExportInput {
  fields: CharacterFields
  extras: CharacterExtras
  extensions?: Record<string, unknown>
  /** 导入时保存的原始卡（可能为 null）。导出时以它的 data 为底，未知字段原样保留 */
  raw: Record<string, unknown> | null
  /** 要嵌入的世界书（主世界书），没有则不写 character_book */
  book: { name: string; entries: LorebookEntryData[] } | null
}

/**
 * 生成 V2 和 V3 两份卡片 JSON（导出 PNG 时分别写进 chara 和 ccv3 文本块，导出 JSON 时用 v3）。
 * - v2：{ spec: 'chara_card_v2', spec_version: '2.0', data }
 * - v3：{ spec: 'chara_card_v3', spec_version: '3.0', data }（v3 的 data 额外有 group_only_greetings，默认 []）
 * - data 以 raw.data（V2/V3 卡）或 raw 本身（V1 卡）为底，再用 fields 覆盖同名字段
 * - data.extensions 保留原有内容，并写入：talkativeness（数字）、
 *   depth_prompt: { prompt: characterNote, depth: characterNoteDepth, role: characterNoteRole }
 * - book 不为空时写入 data.character_book = toCharacterBook(...)；为空时删除原有的 character_book
 */
export function buildCardExport(input: CardExportInput): { v2: Record<string, unknown>; v3: Record<string, unknown> } {
  return card.buildCardExport(input)
}

/**
 * 从角色卡 data.extensions 里读出我们关心的额外设置（导入时用）：
 * talkativeness（数字或数字字符串，0–1，非法时忽略）、depth_prompt.{prompt, depth, role}。
 * 返回只包含读到的字段。
 */
export function readCardExtras(data: Record<string, unknown>): Partial<CharacterExtras> {
  return card.readCardExtras(data)
}
