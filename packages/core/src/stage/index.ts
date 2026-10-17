import type {
  CastMember,
  ChoiceOption,
  DirectiveKind,
  MessageStage,
  PromptList,
  StageOp,
  StagePosition,
  StageState,
  StateSchema,
} from '@ai-parter/shared'
import { renderDirectiveInstructions as renderInstructions } from './instructions'
import * as parser from './parse'
import * as spriteHelpers from './sprites'
import * as stageState from './state'
import * as variables from './vars'

/**
 * VN 模式的舞台指令（纯函数，不读数据库、不发请求）。设计见 docs/design/vn-mode.md 第 3 节。
 *
 * 这个模块会被前端直接引用（@ai-parter/core/stage），所以**只能依赖 @ai-parter/shared**，
 * 不能引入 tokenizer 等只适合后端的模块。
 *
 * 一、能识别的指令（两种风格都认，大小写不敏感，属性值用双引号、单引号或不加引号都行）：
 *
 *   台词速记（一行）：名字[表情]：台词     名字：「台词」
 *     - 冒号可以是全角「：」或半角「:」，表情可省略
 *     - 只有满足下面任一条件才算台词，否则整行当旁白（避免把「注意：……」当成人名）：
 *         a. 名字在 knownNames 里（忽略大小写和首尾空白）
 *         b. 写了 [表情]
 *         c. 冒号后的台词以引号开头：「 『 “ " 之一
 *     - 名字 1–24 个字符，不能以 * 或引号开头，不能包含 [ ] : ： 「 」 < >
 *     - 名字在 narratorNames 里的行当作旁白（去掉「名字：」前缀）
 *
 *   XML 小标签（自闭合或成对，单独成行或嵌在行内都要认）：
 *     <scene bg= bgm= place= time= />          → { op: 'scene', ... }（只带写了的字段）
 *     <show who= at= outfit= expr= />         → { op: 'show', ... }；at 认 left/center/right 或 1–5
 *     <hide who= />                           → { op: 'hide' }
 *     <expr who= v= />（v 也可以写成 expr=）   → { op: 'expr' }
 *     <say who= expr=>台词</say>               → 和台词速记一样产生 line 拍
 *     <state> … </state>                       → 变量更新块（见三）
 *     <choices> - 选项 … </choices>            → 选项块（见四）
 *     <cg prompt= />                           → cg 拍
 *     <sfx name= />                            → sfx 拍
 *     <UpdateVariable> … </UpdateVariable>     → MVU 变量块（见三）
 *     <combat …> / <bgm …>                     → 只隐藏不处理（以后用）
 *   其他标签（比如 <br>、HTML）原样保留，当普通文本。
 *
 * 二、拍（Beat）的切分（parseStageMessage 的 beats）：
 *   - 按出现顺序：舞台操作合并成一个 stage 拍（连续的操作合在同一个拍里），台词一句一拍
 *   - 旁白：每个非空行是一段；超过 narrationSplit 个字（按 Array.from 计数）时在句末标点（。！？…!?）后切开，
 *     切出来的每段不超过 narrationSplit（找不到标点时硬切）
 *   - 台词速记里带了表情时，除了 line 拍，还要往 ops 里加 { op: 'expr', who, expression }；
 *     没带表情时加 { op: 'show', who }（让说话的人上台；已在台上时 foldStage 视为无操作）
 *   - <say> 同理
 *   - <choices> 产生 choices 拍，同时写进 MessageStage.choices（多个块时以最后一个为准）
 *
 * 三、变量（只有 opts.inline / opts.mvu 开启时才处理对应语法；关闭时块照样隐藏，但不产生 varsPatch）：
 *   <state> 块里一行一条（空行和 // 开头的行忽略，行尾的 // 注释去掉）：
 *     路径 = 值        值先按 JSON 解析，失败再去掉首尾的引号（"" '' 「」 “”），否则原样当字符串
 *     路径 += 数字     路径 -= 数字（当前值不是数字时按 0 算）
 *     路径 push 值     往列表末尾加（当前值不是数组时先变成 []）
 *     路径 remove 值   从列表里删掉第一个相等的元素
 *     delete 路径      删除（patch 里记为 null）
 *   MVU：<UpdateVariable> 块（或块外任意位置）里的
 *     _.set('路径', 旧值, 新值);//原因      _.set('路径', 新值);
 *     _.add('路径', 数字);
 *   值的写法是 JS 字面量：数字、单 / 双引号字符串、true/false/null、数组 [...]、对象 {...}（单引号字符串要能解析）。
 *   块里 <Analysis> … </Analysis> 之类的其他内容忽略。
 *   计算基于 opts.vars（这条消息之前的变量），同一条消息里多次修改同一路径时依次累积。
 *   路径是扁平的字符串键（「艾莉丝.好感」整体是一个键，不拆成嵌套对象），和 set_chat_state 工具一致。
 *
 * 四、选项块：每行以 - * • 或「1.」「1、」这类序号开头的是一个选项；
 *   开头的「[技能 DC数字]」或「【技能 DC数字】」解析成 check（DC 大小写不敏感，技能名去掉首尾空白），选项文字里去掉这个前缀。
 */

export interface ParseOptions {
  /** 已知的角色名（群聊成员、单聊角色、当前台上的人），用于判断「名字：台词」是不是台词 */
  knownNames: string[]
  /** 旁白名字（玩法预设的 GM / 旁白名称），这些名字说的话算旁白 */
  narratorNames?: string[]
  /** 这条消息之前的会话变量，用于 += 等计算 */
  vars: Record<string, unknown>
  /** 处理 <state> 块 */
  inline: boolean
  /** 处理 MVU 语法 */
  mvu: boolean
  /** 合法的表情名（28 种 + 自定义），用于给出 warnings；不传则不检查 */
  expressions?: string[]
  /** 旁白拆分长度，默认 120 */
  narrationSplit?: number
}

export interface ParseResult {
  stage: MessageStage
  /** 这条消息对变量的修改；没有任何变量语句时为 null */
  varsPatch: Record<string, unknown> | null
}

/** 解析一条 assistant 消息的全文。流式结束后在后端调用，结果存进 meta.stage / meta.varsPatch */
export function parseStageMessage(content: string, opts: ParseOptions): ParseResult {
  return parser.parseStageMessage(content, opts)
}

export interface DisplayOptions {
  /** 用于判断台词速记（同 ParseOptions.knownNames） */
  knownNames: string[]
  narratorNames?: string[]
  /**
   * 台词的显示方式：
   * - bold：「**名字**：台词」（普通聊天视图，配合前端的 **加粗** 格式）
   * - plain：「名字：台词」（给模型的去指令历史）
   * - none：只保留台词
   */
  speaker: 'bold' | 'plain' | 'none'
  /**
   * 流式中：末尾没写完的标签（比如「<sce」「<state>\n路径 = 」）也要藏起来，
   * 规则是：最后一个 < 之后没有 > 时，从这个 < 截断；有未闭合的 <state> / <choices> / <UpdateVariable> / <say> 块时，
   * 从块的开始标签截断（<say> 例外：显示已经写出来的台词部分）。
   * 非流式时，未闭合的块按到文末结束处理（照样隐藏）。
   */
  streaming?: boolean
}

/**
 * 去掉所有指令后的显示文本：舞台标签、<state>、<choices>、<UpdateVariable>、MVU 语句整行删除，
 * 台词速记和 <say> 按 speaker 改写，表情标记去掉。删除指令后留下的空行合并（连续空行最多保留一个），首尾空白去掉。
 * 旁白、*动作*、引号等其他文字一字不改。
 */
export function toDisplayText(content: string, opts: DisplayOptions): string {
  return parser.toDisplayText(content, opts)
}

/** 演员标识：去掉首尾空白、转小写、去掉内部空白 */
export function castKey(name: string): string {
  return stageState.castKey(name)
}

/** 空舞台 */
export function emptyStage(): StageState {
  return { scene: {}, cast: [] }
}

/**
 * 把一组操作依次应用到舞台上，返回新舞台（不修改入参）：
 * - scene：只覆盖写了的字段；bg 变化时清掉 backgroundId（由后端重新匹配）
 * - show：已在台上 → 只更新写了的 at / outfit / expression（都没写时无操作）；
 *         不在台上 → 加到末尾，expression 默认 ''，at 没写时自动选位置（见 autoPosition）
 * - hide：从台上移除（按 castKey 比较）
 * - expr：在台上 → 改表情；不在台上 → 自动上台并带上这个表情
 * - 名字（name）保留最近一次写法
 */
export function applyStageOps(state: StageState, ops: StageOp[]): StageState {
  return stageState.applyStageOps(state, ops)
}

/** 沿激活路径（从根到叶）依次应用每条消息的 ops */
export function foldStage(opsPerMessage: StageOp[][], initial: StageState = emptyStage()): StageState {
  return opsPerMessage.reduce(applyStageOps, initial)
}

/**
 * 自动选站位：台上没人 → center；
 * 否则依次尝试 left、right、center 里没被占的；三个都占了 → 按 1–5 档找没被占的；全占 → center
 */
export function autoPosition(cast: CastMember[]): StagePosition {
  return stageState.autoPosition(cast)
}

/**
 * 解析 [InitVar] 世界书条目（MVU 的开局变量）。只看 comment（条目备注）里含「[InitVar]」的条目，按传入顺序合并，后面的覆盖前面的。
 * content 是 JSON / JSON5 风格的对象（允许注释、尾逗号、单引号字符串）。嵌套对象拍平成点分隔的键：
 *   { "user": { "当前位置": ["教堂", "移动后改变"] } } → vars["user.当前位置"] = "教堂"，rules["user.当前位置"] = "移动后改变"
 * MVU 的叶子写法是 [值, 说明]（长度为 2 且第二项是字符串）：值进 vars，说明进 rules；其他数组原样当值。
 * 解析失败的条目跳过，并在 errors 里记一条「条目备注：错误原因」。
 */
export function parseInitVars(entries: { comment: string; content: string }[]): {
  vars: Record<string, unknown>
  rules: Record<string, string>
  errors: string[]
} {
  return variables.parseInitVars(entries)
}

/** 解析状态 schema 的 JSON 文本；空串返回 {}；不合法时返回 error（中文）且 schema 为 {} */
export function parseStateSchema(text: string): { schema: StateSchema; error?: string } {
  return variables.parseStateSchema(text)
}

/** 合并两个 schema：同一路径以 primary 为准 */
export function mergeStateSchemas(primary: StateSchema, secondary: StateSchema): StateSchema {
  return { ...secondary, ...primary }
}

/** schema 里写了 init 的字段 → 初始变量 */
export function schemaInitVars(schema: StateSchema): Record<string, unknown> {
  return variables.schemaInitVars(schema)
}

export interface InstructionsInput {
  /** 模板原文；空串时用 DEFAULT_DIRECTIVE_TEMPLATES[style] */
  template: string
  style: 'shorthand' | 'xml'
  kinds: DirectiveKind[]
  lists: PromptList[]
  cast: string[]
  expressions: string[]
  backgrounds: string[]
  schema: StateSchema
  /** InitVar 带来的规则说明，和 schema 的 rule 合并（schema 优先） */
  rules: Record<string, string>
  vars: Record<string, unknown>
  valuesInPrompt: boolean
}

/**
 * 渲染注入 Prompt 的指令说明：
 * - {{vn_kinds}}：按 kinds 顺序取 DIRECTIVE_KIND_GUIDES[style] 里有的段落，用换行连接
 * - {{vn_cast}} / {{vn_expressions}} / {{vn_backgrounds}}：对应 lists 启用且非空时用「、」连接，否则为空
 * - {{vn_state}}：kinds 含 state 且 lists 含 vars 时生成，形如
 *     状态变量（路径：类型，规则；当前值）：
 *     - 艾莉丝.好感：0–100，温柔对待 +1~3；当前 35
 *   变量来自 schema 的键和 vars 的键的并集（schema 的顺序在前）；valuesInPrompt 为 false 时不写当前值；都没有时为空
 * 替换后为空的占位符所在的整行删掉（包括「可登场的角色：」这类前缀），结果去掉首尾空白
 */
export function renderDirectiveInstructions(input: InstructionsInput): string {
  return renderInstructions(input)
}

export type { ChoiceOption }

// ---------------------------------------------------------------------------
// 立绘（VN2）
// ---------------------------------------------------------------------------

/**
 * 从文件名推断表情和服装（导入酒馆立绘包、批量上传时用）。
 * 规则（照酒馆）：去掉扩展名后，第一个「.」或「-」之前的部分是表情，转小写；
 *   joy.png → joy；joy-1.png → joy；joy.expressive.png → joy；Joy_Smile.webp → joy_smile
 * 路径里有一层目录时，目录名是服装：casual/joy.png → { outfit: 'casual', expression: 'joy' }；
 *   更深的目录只取最后一层；没有目录时 outfit 为 ''。
 * 以「.」开头的文件、__MACOSX 目录里的文件返回 null；表情名不是 [a-z0-9_] 组成时返回 null。
 */
export function spriteNameFromPath(path: string): { outfit: string; expression: string } | null {
  return spriteHelpers.spriteNameFromPath(path)
}

export interface SpriteCandidate {
  id: string
  outfit: string
  expression: string
}

/**
 * 给一个演员挑立绘（前端显示用，纯函数）：
 * 1. 在 outfit 服装里找 expression 的立绘；没有时退回默认服装（''）里找
 * 2. 还没有：用 fallback 表情（空串表示不退回）按同样的服装顺序找
 * 3. 都没有返回 null（调用方再决定用头像还是不显示）
 * 同一表情有多张时：random 为 false 取第一张；为 true 用 seed（字符串，比如消息 id）哈希后稳定地选一张——
 * 同一个 seed 永远选同一张，避免重新渲染时闪烁。avoidId 不为空且有别的选择时，跳过这一张（「重复表情时换一张」）。
 */
export function pickSprite<T extends SpriteCandidate>(
  sprites: T[],
  opts: { expression: string; outfit: string; fallback: string; random: boolean; seed: string; avoidId?: string },
): T | null {
  return spriteHelpers.pickSprite(sprites, opts)
}

/** 酒馆「Main API」情绪判断的默认提示词，{{labels}} 换成逗号分隔的表情列表 */
export const DEFAULT_CLASSIFY_PROMPT =
  'Ignore previous instructions. Classify the emotion of the last message. Output just one word, e.g. "joy" or "anger". Choose only one of the following labels: {{labels}}'

/**
 * 从模型的回答里取出表情：转小写后，先找和某个标签完全相同的单词（按 [a-z0-9_] 以外的字符切词）；
 * 没有时再找回答里包含的标签，按标签长度从长到短找，避免短标签误配进长单词里；都没有返回 null。
 */
export function extractExpressionLabel(answer: string, labels: string[]): string | null {
  return spriteHelpers.extractExpressionLabel(answer, labels)
}
