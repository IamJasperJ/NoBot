import { z } from 'zod'
import { promptRoleSchema } from './message'
import { generationTypeSchema } from './preset'

/**
 * 世界书（Lorebook / World Info）。对照酒馆的世界书条目字段设计，
 */

/** 插入位置 */
export const wiPositionSchema = z.enum([
  'before_char', // 角色定义之前
  'after_char', // 角色定义之后
  'before_em', // 示例对话之前（作为一段示例对话）
  'after_em', // 示例对话之后
  'before_an', // 作者注释上方
  'after_an', // 作者注释下方
  'at_depth', // 按深度插入聊天记录
  'outlet', // 不自动插入，用 {{outlet::名字}} 宏手动引用
])
export type WIPosition = z.infer<typeof wiPositionSchema>

export const WI_POSITION_LABELS: Record<WIPosition, string> = {
  before_char: '角色定义之前',
  after_char: '角色定义之后',
  before_em: '示例对话之前',
  after_em: '示例对话之后',
  before_an: '作者注释上方',
  after_an: '作者注释下方',
  at_depth: '按深度插入',
  outlet: 'Outlet（宏引用）',
}

/** 可选过滤关键词的组合逻辑 */
export const selectiveLogicSchema = z.enum(['and_any', 'and_all', 'not_any', 'not_all'])
export type SelectiveLogic = z.infer<typeof selectiveLogicSchema>

/** 除聊天记录外，还可以拿这些内容来匹配关键词 */
export const matchSourceSchema = z.enum([
  'char_description',
  'char_personality',
  'scenario',
  'persona',
  'char_note',
  'creator_notes',
])
export type MatchSource = z.infer<typeof matchSourceSchema>

export const lorebookEntryDataSchema = z.object({
  /** 条目实际激活后自动切换的背景，不参与提示词文本。 */
  backgroundId: z.string().nullable().default(null),
  /** 备注 / 标题，不发给模型 */
  comment: z.string().default(''),
  /** 主关键词。以 / 开头和结尾的按正则匹配，如 /龙(族|人)/i */
  keys: z.array(z.string()).default([]),
  /** 可选过滤关键词 */
  secondaryKeys: z.array(z.string()).default([]),
  selectiveLogic: selectiveLogicSchema.default('and_any'),
  content: z.string().default(''),
  enabled: z.boolean().default(true),
  /** 常驻：不需要关键词也会插入 */
  constant: z.boolean().default(false),
  position: wiPositionSchema.default('before_char'),
  /** at_depth 时生效 */
  depth: z.number().int().min(0).max(9999).default(4),
  /** at_depth 时以什么角色插入 */
  role: promptRoleSchema.default('system'),
  /** 插入顺序：数字大的更靠后（离生成位置更近），预算不够时也优先保留 */
  order: z.number().int().default(100),
  /** 触发概率 0–100 */
  probability: z.number().int().min(0).max(100).default(100),
  useProbability: z.boolean().default(true),
  /** 以下三项为空时继承全局设置 */
  caseSensitive: z.boolean().nullable().default(null),
  matchWholeWords: z.boolean().nullable().default(null),
  scanDepth: z.number().int().min(0).max(1000).nullable().default(null),
  /** 递归：不会被其他条目触发 */
  excludeRecursion: z.boolean().default(false),
  /** 递归：触发后不再触发其他条目 */
  preventRecursion: z.boolean().default(false),
  /** 递归：只在递归扫描时才能被触发 */
  delayUntilRecursion: z.boolean().default(false),
  /** 包含组：同组多个条目同时触发时只保留一个。逗号分隔可属于多个组 */
  group: z.string().default(''),
  /** 组内优先：按 order 最大的保留，而不是按权重随机 */
  groupPrioritize: z.boolean().default(false),
  groupWeight: z.number().int().min(1).default(100),
  /** 组内计分 */
  groupScoring: z.boolean().default(false),
  /** 延迟：聊天里至少有这么多条消息才能触发 */
  delay: z.number().int().min(0).default(0),
  /** 粘滞：触发后持续生效 N 条消息 */
  sticky: z.number().int().min(0).default(0),
  /** 冷却：触发后 N 条消息内不能再触发 */
  cooldown: z.number().int().min(0).default(0),
  /** 角色过滤：只对这些角色名生效（exclude 为 true 时反过来） */
  characterFilter: z
    .object({ names: z.array(z.string()).default([]), exclude: z.boolean().default(false) })
    .default({ names: [], exclude: false }),
  /** 只在这些生成类型下触发，空数组表示全部 */
  triggers: z.array(generationTypeSchema).default([]),
  /** position 为 outlet 时的名字 */
  outletName: z.string().default(''),
  /** 额外的匹配来源 */
  matchSources: z.array(matchSourceSchema).default([]),
  /** 自动化 ID（配合快捷回复脚本） */
  automationId: z.string().default(''),
  /** 向量匹配 */
  vectorized: z.boolean().default(false),
})
export type LorebookEntryData = z.infer<typeof lorebookEntryDataSchema>

export interface LorebookEntryDTO extends LorebookEntryData {
  id: string
  lorebookId: string
}

export interface LorebookDTO {
  id: string
  name: string
  description: string
  isGlobal: boolean
  entryCount: number
  updatedAt: number
}

export const lorebookInput = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(''),
  isGlobal: z.boolean().default(false),
})
export type LorebookInput = z.input<typeof lorebookInput>

/** 世界书的全局激活设置（对应酒馆世界书页顶部的 Activation Settings） */
export const worldInfoSettingsSchema = z.object({
  /** 扫描最近多少条消息 */
  scanDepth: z.number().int().min(0).max(1000).default(2),
  /** 预算：上下文长度的百分比 */
  budgetPercent: z.number().int().min(1).max(100).default(100),
  /** 预算上限（token），0 表示不限 */
  budgetCap: z.number().int().min(0).default(0),
  /** 扫描时给每条消息加上发言人名字前缀 */
  includeNames: z.boolean().default(false),
  recursive: z.boolean().default(true),
  /** 最多递归几轮，0 表示不限 */
  maxRecursionSteps: z.number().int().min(0).max(10).default(0),
  caseSensitive: z.boolean().default(false),
  matchWholeWords: z.boolean().default(false),
  /** 多个来源的条目怎么排：均匀排序 / 角色优先 / 全局优先 */
  insertionStrategy: z.enum(['evenly', 'character_first', 'global_first']).default('character_first'),
  /** 最少激活数 */
  minActivations: z.number().int().min(0).default(0),
  /** 扩大扫描的最大深度，0 表示扫描全部历史 */
  maxDepth: z.number().int().min(0).max(1000).default(0),
  vectorEnabled: z.boolean().default(false),
  embeddingConnectionId: z.string().nullable().default(null),
  embeddingModel: z.string().default(''),
  vectorThreshold: z.number().min(0).max(1).default(0.25),
  vectorMaxEntries: z.number().int().min(0).default(5),
  vectorQueryMessages: z.number().int().min(1).default(2),
})
export type WorldInfoSettings = z.infer<typeof worldInfoSettingsSchema>

/** 一次扫描里某个条目的结果，用于 Prompt 预览 */
export interface WIActivation {
  entryId: string
  lorebookId: string
  lorebookName: string
  comment: string
  position: WIPosition
  /** 触发原因：常驻 / 命中的关键词 / 递归 */
  reasonCode: 'none' | 'constant' | 'sticky' | 'vector' | 'keyword' | 'recursive'
  reasonParams?: { key: string }
  activated: boolean
  /** 没有插入时的原因：预算、概率、包含组…… */
  skippedCode?: 'no_match' | 'cooldown' | 'budget' | 'probability' | 'group' | 'delay'
  skippedParams?: { group: string }
  /** 是否因世界书预算被淘汰 */
  dropped?: boolean
  tokens: number
}
