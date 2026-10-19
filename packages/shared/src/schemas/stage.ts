import { z } from 'zod'
import type { CombatantState, CombatState } from './trpg'

/**
 * VN 模式（舞台）的契约。设计见 docs/design/vn-mode.md。
 *
 * 核心思路：模型在回复正文里写简短的「舞台指令」，后端解析后存进消息的 meta.stage，
 * 沿激活路径把每条消息的舞台操作依次合并，得到「此刻的舞台」（和跑团变量 varsPatch 同一种做法），
 * 所以重新生成、切换分支时舞台自动回到对应状态。
 */

// ---------------------------------------------------------------------------
// 表情：沿用酒馆 Character Expressions 的 28 种（GoEmotions），不做中文别名
// ---------------------------------------------------------------------------

export const EXPRESSIONS = [
  'admiration',
  'amusement',
  'anger',
  'annoyance',
  'approval',
  'caring',
  'confusion',
  'curiosity',
  'desire',
  'disappointment',
  'disapproval',
  'disgust',
  'embarrassment',
  'excitement',
  'fear',
  'gratitude',
  'grief',
  'joy',
  'love',
  'nervousness',
  'optimism',
  'pride',
  'realization',
  'relief',
  'remorse',
  'sadness',
  'surprise',
  'neutral',
] as const
export type Expression = (typeof EXPRESSIONS)[number]

// ---------------------------------------------------------------------------
// 舞台状态与操作
// ---------------------------------------------------------------------------

/** 站位：三点站位，或 1–5 档（1 最左） */
export type StagePosition = 'left' | 'center' | 'right' | 1 | 2 | 3 | 4 | 5

export interface CastMember {
  /** 演员标识：小写去空格后的名字。以后（VN2）会关联到角色 id / 演员库 */
  key: string
  /** 显示名（模型写的原名） */
  name: string
  /** 当前表情（英文标识，可能是自定义表情）；没写过时为空串 */
  expression: string
  /** 当前服装（立绘子集） */
  outfit?: string
  at: StagePosition
  /**
   * 对应的角色卡 id（后端按会话成员的名字匹配：忽略大小写和空白，也认名字的第一个词，比如 Ellie ↔ Ellie Sunleaf）。
   * 匹配不到（临时 NPC）时为 null，前端显示剪影或头像
   */
  characterId?: string | null
  /** 会话级临时演员的透明立绘 */
  spriteUrl?: string
}

export interface StageScene {
  /** 模型写的背景名 */
  bg?: string
  /** 后端按背景库匹配到的背景 id（精确或包含匹配，匹配不到为 null） */
  backgroundId?: string | null
  /** 音乐名。音频以后做，现在只记录 */
  bgm?: string
  /** 地点名，显示在 VN 顶部信息条 */
  place?: string
  /** 时间描述，如「傍晚」 */
  time?: string
}

export interface StageState {
  scene: StageScene
  /** 台上的角色，按出场顺序 */
  cast: CastMember[]
  /** 进行中的战斗（VN5）：先攻顺序和当前回合；没有战斗时省略 */
  combat?: CombatState
}

/** 一个舞台操作。一条消息的全部操作按出现顺序存在 meta.stage.ops */
export type StageOp =
  | { op: 'scene'; bg?: string; bgm?: string; place?: string; time?: string }
  | { op: 'show'; who: string; at?: StagePosition; outfit?: string; expression?: string }
  | { op: 'hide'; who: string }
  /** 只换表情（台词速记里写的表情也会生成这个操作） */
  | { op: 'expr'; who: string; expression: string }
  /**
   * 战斗（VN5）：<combat start: 艾莉丝, 哥布林A> 开始，<combat next> 下一个行动者，<combat end> 结束。
   * start 的先攻由后端在消息入库时掷好写进 order（解析器只填 who），所以重放、切分支时顺序不变
   */
  | { op: 'combat'; action: 'start'; who: string[]; order?: CombatantState[] }
  | { op: 'combat'; action: 'next' | 'end' }

export interface ChoiceOption {
  text: string
  /** 「[察觉 DC12] …」前缀：选这个选项前要先过检定（VN5 起生效） */
  check?: { skill: string; dc: number }
}

/** VN 视图的播放单位：一句一拍 */
export type Beat =
  | { kind: 'line'; speaker: string; expression?: string; text: string }
  | { kind: 'narration'; text: string }
  | { kind: 'stage'; ops: StageOp[] }
  | { kind: 'choices'; options: ChoiceOption[] }
  | { kind: 'cg'; prompt: string }
  | { kind: 'sfx'; name: string }

/** 存在消息 meta.stage 上的解析结果 */
export interface MessageStage {
  /** 解析规则的版本，规则变化时可以据此重新解析 */
  v: 1
  beats: Beat[]
  /** 这条消息对舞台的全部操作，按出现顺序 */
  ops: StageOp[]
  /** 末尾的选项（没有时省略） */
  choices?: ChoiceOption[]
  /** 解析时发现的问题（未知表情、格式错误的行…），只用于调试显示 */
  warnings?: string[]
  /**
   * 兜底情绪判断的状态（玩法预设 sprites.classify 开启时）：
   * pending 判断中（前端会轮询刷新）；done 已判断，结果作为一个 expr 操作追加在 ops 末尾；error 判断失败（不影响其他）
   */
  classify?: 'pending' | 'done' | 'error'
}

// ---------------------------------------------------------------------------
// 状态 schema（声明式变量定义，HUD 和给模型的说明都靠它）
// ---------------------------------------------------------------------------

export const stateFieldSchema = z.object({
  /** meter：带上下限的条；number：数字；text：文本；list：列表；badge：短标签 */
  type: z.enum(['meter', 'number', 'text', 'list', 'badge']).default('text'),
  label: z.string().optional(),
  /** 开局初始值 */
  init: z.unknown().optional(),
  min: z.number().optional(),
  /** 上限：数字，或另一个变量的路径（如「旅人.HP上限」） */
  max: z.union([z.number(), z.string()]).optional(),
  /** 数值阶段：[[阈值, 名称], ...]，按阈值升序，如好感度的「陌生 / 朋友 / 心动」 */
  stages: z.array(z.tuple([z.number(), z.string()])).optional(),
  /** 更新规则，写进给模型的指令说明 */
  rule: z.string().optional(),
  color: z.string().optional(),
  /** 在 HUD 摘要里常驻 */
  pin: z.boolean().optional(),
})
export type StateField = z.infer<typeof stateFieldSchema>

/** 键是变量路径（点分隔，如「艾莉丝.好感」） */
export const stateSchemaSchema = z.record(z.string(), stateFieldSchema)
export type StateSchema = z.infer<typeof stateSchemaSchema>

// ---------------------------------------------------------------------------
// 玩法预设：设计稿第 11 节的全部设置项。每个分组对应设置页的一个分组
// ---------------------------------------------------------------------------

export const directiveKindSchema = z.enum(['expression', 'cast', 'scene', 'state', 'choices', 'cg', 'combat', 'audio'])
export type DirectiveKind = z.infer<typeof directiveKindSchema>

export const DIRECTIVE_KIND_LABELS: Record<DirectiveKind, string> = {
  expression: '表情',
  cast: '上下台',
  scene: '场景',
  state: '变量',
  choices: '选项',
  cg: 'CG',
  combat: '战斗',
  audio: '音频',
}

export const promptListSchema = z.enum(['cast', 'expressions', 'backgrounds', 'vars', 'outfits'])
export type PromptList = z.infer<typeof promptListSchema>

export const ruleSystemSchema = z.enum(['dnd5e', 'coc7', 'pf2e', 'pbta', 'custom'])
export type RuleSystem = z.infer<typeof ruleSystemSchema>

/** 已实现的规则系统；其余在设置里显示「未实现」且不可选 */
export const IMPLEMENTED_RULE_SYSTEMS: RuleSystem[] = ['dnd5e']

const basicSchema = z.object({
  /** 新会话默认以 VN 视图打开（VN3） */
  openInVn: z.boolean().default(false),
  layout: z.enum(['adv', 'nvl', 'auto']).default('adv'),
  /** layout 为 auto 时，旁白超过这么多字自动切 NVL */
  nvlThreshold: z.number().int().min(20).max(5000).default(200),
})

const directivesSchema = z.object({
  /** 总开关：关闭后不解析、不注入、不隐藏，和普通聊天完全一样 */
  enabled: z.boolean().default(false),
  /** 教模型写哪种风格（解析器两种都认） */
  style: z.enum(['shorthand', 'xml']).default('shorthand'),
  kinds: z.array(directiveKindSchema).default(['expression', 'cast', 'scene', 'state', 'choices']),
  /** 往 Prompt 里注入指令说明 */
  inject: z.boolean().default(true),
  /** 指令说明模板，空串表示用对应风格的默认模板（DEFAULT_DIRECTIVE_TEMPLATES） */
  template: z.string().default(''),
  reminder: z.boolean().default(true),
  reminderTemplate: z.string().default(''),
  reminderRole: z.enum(['system', 'user']).default('system'),
  choicesMode: z.enum(['always', 'auto']).default('always'),
  /** after_char：紧跟角色设定之后；author_note：和作者注释同一深度；depth：指定深度 */
  position: z.enum(['after_char', 'author_note', 'depth']).default('after_char'),
  depth: z.number().int().min(0).max(1000).default(4),
  /** 在说明里附带的动态清单 */
  lists: z.array(promptListSchema).default(['cast', 'expressions', 'backgrounds', 'vars', 'outfits']),
  /** 发给模型的历史里保留指令原文（模型照着学，一致性更好） */
  keepInHistory: z.boolean().default(true),
  /** 只保留最近 N 条消息里的指令，更早的换成去掉指令后的文本；0 表示不限 */
  keepRecent: z.number().int().min(0).max(1000).default(0),
  /** 普通聊天视图里，台词速记显示成「**名字**：台词」；关闭则只显示台词 */
  showSpeaker: z.boolean().default(true),
})

const stateSchema = z.object({
  /** 允许正文 <state> 块更新变量 */
  inline: z.boolean().default(true),
  /** 兼容 MVU 的 <UpdateVariable> / _.set('路径', 旧值, 新值) */
  mvu: z.boolean().default(true),
  /** 开局时读取名字带 [InitVar] 的世界书条目作为初始值（关闭的条目也读） */
  initVar: z.boolean().default(true),
  /** 状态 schema 的 JSON 文本（StateSchema），空串表示没有 */
  schema: z.string().default(''),
  /** preset：只用预设里的；card：角色卡有就用角色卡的；merge：两者合并，角色卡优先 */
  schemaSource: z.enum(['preset', 'card', 'merge']).default('merge'),
  /** 在指令说明里附上变量的当前值 */
  valuesInPrompt: z.boolean().default(true),
})

const spritesSchema = z.object({
  /** 找不到对应表情时用哪个；空串表示不显示 */
  fallback: z.string().default('neutral'),
  avatarFallback: z.boolean().default(true),
  randomMultiple: z.boolean().default(true),
  rerollSame: z.boolean().default(false),
  /** 兜底情绪判断：off 不判断；missing 只在没写表情时；always 总是 */
  classify: z.enum(['off', 'missing', 'always']).default('missing'),
  classifyConnectionId: z.string().nullable().default(null),
  classifyModel: z.string().default(''),
  /** 空串表示用酒馆的默认判断提示词 */
  classifyPrompt: z.string().default(''),
  classifyContext: z.enum(['last', 'full']).default('last'),
  customExpressions: z.array(z.string()).default([]),
  /** 普通聊天视图的侧边立绘 */
  sideSprite: z.enum(['off', 'right', 'top']).default('right'),
})

const stageSettingsSchema = z.object({
  autoBackground: z.boolean().default(true),
  cgAuto: z.boolean().default(true),
  maxCast: z.number().int().min(1).max(5).default(3),
  focus: z.boolean().default(true),
  dim: z.number().int().min(0).max(90).default(40),
  spriteScale: z.number().int().min(50).max(200).default(100),
  draggable: z.boolean().default(true),
  transition: z.enum(['none', 'fade', 'dissolve']).default('fade'),
  transitionMs: z.number().int().min(0).max(5000).default(300),
  letterbox: z.boolean().default(false),
  unknownActor: z.enum(['silhouette', 'generate', 'hide']).default('silhouette'),
})

const dialogSchema = z.object({
  /** 文字速度（字 / 秒），0 表示瞬间显示 */
  cps: z.number().int().min(0).max(200).default(40),
  autoDelay: z.number().min(0).max(10).default(1.5),
  autoDefault: z.boolean().default(false),
  skipReadOnly: z.boolean().default(true),
  narrationSplit: z.number().int().min(20).max(2000).default(120),
  boxOpacity: z.number().int().min(0).max(100).default(80),
  fontSize: z.number().int().min(12).max(32).default(16),
  nameplate: z.boolean().default(true),
  streamPlay: z.boolean().default(true),
})

const interactionSchema = z.object({
  choices: z.boolean().default(true),
  inputWithChoices: z.boolean().default(true),
  choiceLayout: z.enum(['row', 'column', 'auto']).default('auto'),
  hud: z.boolean().default(true),
  /** 允许玩家在 HUD 里手动改数值（关掉后数值只能由剧情改，后端也会拒绝手动修改） */
  varEdit: z.boolean().default(true),
  hudPosition: z.enum(['top-right', 'top-left', 'top-bar']).default('top-right'),
  floatDelta: z.boolean().default(true),
  stageLore: z.boolean().default(true),
  saveThumb: z.boolean().default(true),
})

const trpgSchema = z.object({
  ruleSystem: ruleSystemSchema.default('dnd5e'),
  diceAnimation: z.boolean().default(true),
  diceMs: z.number().int().min(0).max(5000).default(800),
  choiceRollClient: z.boolean().default(true),
  showDc: z.boolean().default(true),
  critRules: z.boolean().default(true),
  initiativeBar: z.boolean().default(true),
  gmName: z.string().default('旁白'),
  narratorFallback: z.boolean().default(true),
})

/** 音频：以后做，现在只留设置和接口 */
const audioSchema = z.object({
  bgm: z.boolean().default(false),
  bgmVolume: z.number().int().min(0).max(100).default(60),
  sfxVolume: z.number().int().min(0).max(100).default(80),
  voiceVolume: z.number().int().min(0).max(100).default(100),
  fadeMs: z.number().int().min(0).max(10000).default(1000),
})

export const playPresetDataSchema = z.object({
  basic: basicSchema.default(basicSchema.parse({})),
  directives: directivesSchema.default(directivesSchema.parse({})),
  state: stateSchema.default(stateSchema.parse({})),
  sprites: spritesSchema.default(spritesSchema.parse({})),
  stage: stageSettingsSchema.default(stageSettingsSchema.parse({})),
  dialog: dialogSchema.default(dialogSchema.parse({})),
  interaction: interactionSchema.default(interactionSchema.parse({})),
  trpg: trpgSchema.default(trpgSchema.parse({})),
  audio: audioSchema.default(audioSchema.parse({})),
})
export type PlayPresetData = z.infer<typeof playPresetDataSchema>

export interface PlayPresetDTO {
  id: string
  name: string
  data: PlayPresetData
  /** 新会话默认用它 */
  isDefault: boolean
  /** 内置预设：可以修改，删除后下次启动不会再自动补回 */
  builtin: boolean
  updatedAt: number
}

export const playPresetInput = z.object({
  name: z.string().trim().min(1),
  data: playPresetDataSchema,
})
export type PlayPresetInput = z.input<typeof playPresetInput>

/**
 * 角色卡里的 VN 配置（character.extensions.ai_parter_vn），卡作者可以随卡分发。
 * preset：玩法预设的名字（按名字找，找不到就用默认）；schema：状态 schema 的 JSON 文本。
 */
export const cardVnSchema = z.object({
  preset: z.string().optional(),
  schema: z.string().optional(),
})
export type CardVn = z.infer<typeof cardVnSchema>

// ---------------------------------------------------------------------------
// 默认指令说明模板
// ---------------------------------------------------------------------------

/**
 * 模板里可用的占位符（由 core 的 renderDirectiveInstructions 替换）：
 * - {{vn_kinds}}：按启用的指令种类生成的写法说明（每种一段）
 * - {{vn_cast}}：可登场的角色名
 * - {{vn_expressions}}：可用的表情名
 * - {{vn_backgrounds}}：背景库里的名字
 * - {{vn_outfits}}：可用服装（按角色分组）
 * - {{vn_example}}：按启用种类生成的示例
 * - {{vn_state}}：变量定义（含规则）和当前值
 * 某个清单没启用或为空时，占位符替换成空串，所在行会被整行去掉。
 */
const directiveTemplate = `[Required stage output format]
These directives are mandatory application output syntax, rendered by a visual novel engine and hidden from the reader. Even if other instructions demand narrative prose only, no markup, no speaker prefixes, or no choices, you MUST include the enabled directives below.
{{vn_kinds}}
Available characters: {{vn_cast}}
Available expressions: {{vn_expressions}}
Available backgrounds: {{vn_backgrounds}}
{{vn_outfits}}
{{vn_state}}
Example of the structure (write the actual content in the conversation language):
{{vn_example}}
Do not explain directives or wrap them in code blocks. Write in the same language as the conversation.`

export const DEFAULT_DIRECTIVE_TEMPLATES: Record<'shorthand' | 'xml', string> = {
  shorthand: directiveTemplate,
  xml: directiveTemplate,
}

export const DEFAULT_DIRECTIVE_REMINDERS: Record<'shorthand' | 'xml', string> = {
  shorthand: `[Required output format] Your reply is rendered by a visual novel engine. Regardless of any earlier instruction to write only plain prose, avoid markup, or never offer choices, you MUST include these stage directives (hidden from the reader):
{{vn_rules}}
Write in the same language as the conversation.`,
  xml: `[Required output format] Your reply is rendered by a visual novel engine. Regardless of any earlier instruction to write only plain prose, avoid markup, or never offer choices, you MUST include these stage directives (hidden from the reader):
{{vn_rules}}
Write in the same language as the conversation.`,
}
