import { z } from 'zod'

/**
 * VN5 跑团的契约。设计见 docs/design/vn-mode.md 第 6.2 节。
 *
 * - 角色属性（sheet）：玩家挂在用户人设上，队友 / 固定 NPC 挂在角色卡上（导出时写进角色卡 extensions）。
 *   跑团过程中会变的量（当前 HP、状态效果）走会话变量 `<名字>.HP`、`<名字>.状态`，沿消息树回溯；sheet 只是底子
 * - 掷骰和检定都在后端（工具）或后端接口里完成，随机数从参数传入 core 的纯函数，结果写进消息 meta，前端只负责演出
 */

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const
export type Ability = (typeof ABILITIES)[number]

/** 六维的中文名（界面用 t() 翻译；给模型看的说明里用英文 id） */
export const ABILITY_LABELS: Record<Ability, string> = {
  str: '力量',
  dex: '敏捷',
  con: '体质',
  int: '智力',
  wis: '感知',
  cha: '魅力',
}

/** D&D 5e 的 18 项技能：英文 id → 关联属性 + 中文名 */
export const DND5E_SKILLS = {
  acrobatics: { ability: 'dex', label: '杂技' },
  animal_handling: { ability: 'wis', label: '驯兽' },
  arcana: { ability: 'int', label: '奥秘' },
  athletics: { ability: 'str', label: '运动' },
  deception: { ability: 'cha', label: '欺瞒' },
  history: { ability: 'int', label: '历史' },
  insight: { ability: 'wis', label: '洞悉' },
  intimidation: { ability: 'cha', label: '威吓' },
  investigation: { ability: 'int', label: '调查' },
  medicine: { ability: 'wis', label: '医药' },
  nature: { ability: 'int', label: '自然' },
  perception: { ability: 'wis', label: '察觉' },
  performance: { ability: 'cha', label: '表演' },
  persuasion: { ability: 'cha', label: '游说' },
  religion: { ability: 'int', label: '宗教' },
  sleight_of_hand: { ability: 'dex', label: '巧手' },
  stealth: { ability: 'dex', label: '隐匿' },
  survival: { ability: 'wis', label: '求生' },
} as const satisfies Record<string, { ability: Ability; label: string }>
export type Dnd5eSkill = keyof typeof DND5E_SKILLS

const score = z.number().int().min(1).max(30).default(10)

/** 一份角色属性卡（D&D 5e）。以后加别的规则系统时按 ruleSystem 区分 */
export const characterSheetSchema = z.object({
  ruleSystem: z.literal('dnd5e').default('dnd5e'),
  level: z.number().int().min(1).max(20).default(1),
  /** 职业 / 种族等自由文本，写进给模型的说明 */
  summary: z.string().default(''),
  abilities: z
    .object({ str: score, dex: score, con: score, int: score, wis: score, cha: score })
    .default({ str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }),
  /** 最大 HP；当前 HP 由会话变量 `<名字>.HP` 记录，开局时用它初始化 */
  hpMax: z.number().int().min(1).max(9999).default(10),
  ac: z.number().int().min(0).max(50).default(10),
  speed: z.number().int().min(0).max(200).default(30),
  /** 熟练加值；null 表示按等级自动计算（1–4 级 +2，每 4 级 +1） */
  proficiency: z.number().int().min(0).max(10).nullable().default(null),
  /** 熟练的技能（DND5E_SKILLS 的 id） */
  skills: z.array(z.string()).default([]),
  /** 专精（熟练加值翻倍）的技能 */
  expertise: z.array(z.string()).default([]),
  /** 熟练的豁免 */
  saves: z.array(z.enum(ABILITIES)).default([]),
  /** 开局时的状态效果（中毒、倒地……），之后由会话变量 `<名字>.状态` 记录 */
  conditions: z.array(z.string()).default([]),
  /** 装备 / 法术 / 特性等备注，写进给模型的说明 */
  notes: z.string().default(''),
})
export type CharacterSheet = z.infer<typeof characterSheetSchema>

/** DiceResult 的运行时 schema（前端随消息发回检定结果时校验用） */
export const diceResultSchema = z.object({
  expression: z.string(),
  groups: z.array(
    z.object({
      sides: z.number().int().min(2),
      rolls: z.array(z.object({ value: z.number().int(), kept: z.boolean() })),
    }),
  ),
  modifier: z.number().int(),
  total: z.number().int(),
  natural: z.enum(['crit', 'fumble']).optional(),
  advantage: z.enum(['advantage', 'disadvantage']).optional(),
  reason: z.string().optional(),
})

/** 一次掷骰的完整结果（存进消息 meta.dice，前端据此演出动画） */
export interface DiceResult {
  /** 规范化后的表达式，如 2d20kh1+5 */
  expression: string
  /** 每一组骰子：几面骰、每颗点数、是否计入（取高 / 取低时被舍弃的为 false） */
  groups: { sides: number; rolls: { value: number; kept: boolean }[] }[]
  /** 常数修正值之和 */
  modifier: number
  total: number
  /** 只对单颗 d20（含优势 / 劣势取到的那颗）判定：自然 20 / 自然 1 */
  natural?: 'crit' | 'fumble'
  advantage?: 'advantage' | 'disadvantage'
  /** 掷骰目的，如「攻击哥布林」 */
  reason?: string
}

/** 检定（属性 / 技能 / 豁免）的结果，存进消息 meta.check */
export interface CheckResult {
  /** 谁在检定（显示名） */
  who: string
  /** 技能 id、属性 id，或模型写的原文（无法识别时按纯属性 0 加值处理） */
  skill: string
  kind: 'skill' | 'ability' | 'save'
  ability: Ability
  dc: number | null
  roll: DiceResult
  /** 属性调整值 + 熟练 / 专精 */
  bonus: number
  total: number
  /** 没有 DC 时为 null */
  success: boolean | null
  /** total - dc */
  margin: number | null
  /** 大成功 / 大失败规则生效后的结论（关闭该规则时只看点数） */
  outcome: 'crit_success' | 'success' | 'fail' | 'crit_fail' | null
  /** 加值是从哪里来的：角色卡、会话变量，或没找到属性（按 0） */
  source: 'sheet' | 'vars' | 'none'
}

/** CheckResult 的运行时 schema：选项检定的结果随 send 请求发回后端时校验 */
export const checkResultSchema = z.object({
  who: z.string(),
  skill: z.string(),
  kind: z.enum(['skill', 'ability', 'save']),
  ability: z.enum(ABILITIES),
  dc: z.number().int().min(0).max(100).nullable(),
  roll: diceResultSchema,
  bonus: z.number().int(),
  total: z.number().int(),
  success: z.boolean().nullable(),
  margin: z.number().int().nullable(),
  outcome: z.enum(['crit_success', 'success', 'fail', 'crit_fail']).nullable(),
  source: z.enum(['sheet', 'vars', 'none']),
})

/** 战斗中的一个参与者（舞台状态 combat.order 的一项） */
export interface CombatantState {
  key: string
  name: string
  initiative: number
  characterId?: string | null
}

/** 舞台状态里的战斗（StageState.combat），没有战斗时省略 */
export interface CombatState {
  round: number
  /** 当前行动者在 order 里的下标 */
  turn: number
  order: CombatantState[]
}

/** 选项检定：前端点选带检定的选项时先调用，后端按角色卡掷骰后返回结果，再随消息一起发送 */
export const choiceCheckInput = z.object({
  skill: z.string().trim().min(1),
  dc: z.number().int().min(0).max(100),
  /** 谁检定；默认当前用户人设 */
  who: z.string().trim().optional(),
  advantage: z.enum(['advantage', 'disadvantage']).optional(),
})
export type ChoiceCheckInput = z.infer<typeof choiceCheckInput>
