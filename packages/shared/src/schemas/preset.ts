import { z } from 'zod'
import { promptRoleSchema } from './message'

/**
 * 生成预设（对应酒馆的「AI 响应配置」+ Prompt 管理器）。
 *
 * 字段旁标了「未实现」的，界面上会显示出来但暂时不生效，方便以后补上。
 * 所有字段都有默认值：旧预设缺字段时会自动补齐，导入别人的预设也不会出错。
 */

/** 生成类型。Prompt 条目和世界书条目可以限定只在某些类型下生效 */
export const generationTypeSchema = z.enum(['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'])
export type GenerationType = z.infer<typeof generationTypeSchema>

export const GENERATION_TYPE_LABELS: Record<GenerationType, string> = {
  normal: '普通发送',
  continue: '续写',
  impersonate: '代写',
  swipe: '滑动生成',
  regenerate: '重新生成',
  quiet: '后台生成',
}

// ---- 采样参数 ----

export const samplerSchema = z.object({
  /** 上下文长度（token） */
  contextSize: z.number().int().min(512).max(2_000_000).default(16384),
  /** 最大回复长度（token） */
  maxTokens: z.number().int().min(1).max(200_000).default(1024),
  /** 流式传输 */
  stream: z.boolean().default(true),
  /** 每次生成多个回复（n）。未实现 */
  n: z.number().int().min(1).max(8).default(1),
  temperature: z.number().min(0).max(2).default(1),
  frequencyPenalty: z.number().min(-2).max(2).default(0),
  presencePenalty: z.number().min(-2).max(2).default(0),
  topP: z.number().min(0).max(1).default(1),
  /** 以下四个是非 OpenAI 标准参数，只在不是默认值时才发送（OpenRouter、本地模型等支持） */
  topK: z.number().int().min(0).max(500).default(0),
  minP: z.number().min(0).max(1).default(0),
  topA: z.number().min(0).max(1).default(0),
  repetitionPenalty: z.number().min(0).max(3).default(1),
  /** 随机种子，-1 表示随机 */
  seed: z.number().int().default(-1),
  /** Logit Bias。未实现（需要按模型的分词器把文字转成 token id） */
  logitBias: z.array(z.object({ text: z.string(), value: z.number().min(-100).max(100) })).default([]),
  /** 自定义停止序列 */
  stop: z.array(z.string()).default([]),
  /** 推理强度：auto 表示不发送这个参数 */
  reasoningEffort: z.enum(['auto', 'minimal', 'low', 'medium', 'high']).default('auto'),
  /** 请求模型返回思考过程（OpenRouter 的 include_reasoning） */
  requestReasoning: z.boolean().default(false),
  /** 启用工具调用（function calling） */
  functionCalling: z.boolean().default(false),
  /** 单独关闭的工具（按工具名）。默认全部开启，新装扩展带来的工具也默认开启 */
  disabledTools: z.array(z.string()).default([]),
  /** 接口自带的联网搜索。未实现 */
  webSearch: z.boolean().default(false),
  /** 发送图片给多模态模型。未实现 */
  inlineImages: z.boolean().default(false),
  /** 额外的请求体参数（JSON 文本），原样合并进请求体，用来传各家的私有参数 */
  extraBody: z.string().default(''),
})
export type SamplerSettings = z.infer<typeof samplerSchema>

// ---- Prompt 管理器 ----

/**
 * 内置条目的 id。marker 类条目的内容来自角色卡 / 世界书 / 聊天记录，不能编辑文字；
 * 其余内置条目和自定义条目都是可编辑的文本。
 */
export const BUILTIN_PROMPTS = {
  main: { name: '主提示词', marker: false },
  auxiliary: { name: '辅助提示词', marker: false },
  enhance_definitions: { name: '增强定义', marker: false },
  post_history: { name: '历史后指令', marker: false },
  wi_before: { name: '世界书（角色前）', marker: true },
  char_description: { name: '角色描述', marker: true },
  char_personality: { name: '角色性格', marker: true },
  scenario: { name: '场景', marker: true },
  wi_after: { name: '世界书（角色后）', marker: true },
  persona: { name: '用户人设', marker: true },
  examples: { name: '示例对话', marker: true },
  history: { name: '聊天记录', marker: true },
} as const
export type BuiltinPromptId = keyof typeof BUILTIN_PROMPTS

export const promptBlockSchema = z.object({
  /** 内置条目用固定 id，自定义条目用随机 id */
  id: z.string().min(1),
  name: z.string().default(''),
  role: promptRoleSchema.default('system'),
  content: z.string().default(''),
  enabled: z.boolean().default(true),
  /** relative：按列表顺序放置；in_chat：按深度插进聊天记录 */
  position: z.enum(['relative', 'in_chat']).default('relative'),
  /** in_chat 时生效：0 = 最后一条消息之后，1 = 最后一条之前…… */
  depth: z.number().int().min(0).max(9999).default(4),
  /** in_chat 时生效：同一深度里数字小的在前 */
  order: z.number().int().default(100),
  /** 只在这些生成类型下发送，空数组表示全部 */
  triggers: z.array(generationTypeSchema).default([]),
})
export type PromptBlock = z.infer<typeof promptBlockSchema>

// ---- 辅助提示词（对应酒馆 Utility Prompts） ----

export const utilityPromptsSchema = z.object({
  /** 世界书条目的包装格式，{0} 是条目内容 */
  worldInfoFormat: z.string().default('{0}'),
  scenarioFormat: z.string().default('{{scenario}}'),
  personalityFormat: z.string().default('{{personality}}'),
  /** 群聊时放在最后，要求指定角色回复。留空则不发送 */
  groupNudge: z.string().default('[接下来只以{{char}}的身份写一条回复。]'),
  /** 放在聊天记录之前，标记背景信息结束、对话开始。留空则不发送 */
  newChat: z.string().default('[开始新的对话]'),
  newGroupChat: z.string().default('[开始新的群聊。成员：{{group}}]'),
  newExampleChat: z.string().default('[示例对话]'),
  /** 续写时放在最后的提示 */
  continueNudge: z.string().default('[接着写下面这条消息，不要重复原文，直接从断开的地方继续：{{lastChatMessage}}]'),
  /** 代写时的提示 */
  impersonation: z
    .string()
    .default(
      '[以{{user}}的视角写下{{user}}的下一条回复，参考聊天记录里{{user}}的写作风格。不要以{{char}}或系统的身份写，不要描写{{char}}的行动。]',
    ),
  /** 输入框为空时直接发送，用这段文字代替空消息。留空则发送空消息 */
  sendIfEmpty: z.string().default(''),
})
export type UtilityPrompts = z.infer<typeof utilityPromptsSchema>

// ---- 行为开关 ----

export const behaviorSchema = z.object({
  /**
   * 角色名的发送方式：
   * - none：不加名字
   * - default：只在群聊里给消息加「名字: 」前缀
   * - completion：放进消息对象的 name 字段（只支持英文数字，不合法时退回前缀）
   * - content：总是给消息加「名字: 」前缀
   */
  namesBehavior: z.enum(['none', 'default', 'completion', 'content']).default('default'),
  /** 续写时把原消息作为 assistant 预填充发送，而不是发续写提示 */
  continuePrefill: z.boolean().default(false),
  /** 续写结果前面补的连接符 */
  continuePostfix: z.enum(['', ' ', '\n', '\n\n']).default(' '),
  /** 合并连续的 system 消息（示例对话除外） */
  squashSystem: z.boolean().default(false),
  /**
   * 后处理：
   * - none：不处理
   * - merge：合并相邻同角色消息
   * - semi_strict：合并，并且只保留开头的 system，后面的 system 改成 user
   * - strict：在 semi_strict 基础上，保证第一条非 system 消息是 user
   * - single_user：全部合成一条 user 消息
   */
  postProcessing: z.enum(['none', 'merge', 'semi_strict', 'strict', 'single_user']).default('merge'),
  /** 回复的预填充（放在最后的 assistant 消息），只有部分接口支持 */
  assistantPrefill: z.string().default(''),
  /** 代写时的预填充 */
  assistantImpersonationPrefill: z.string().default(''),
  /** 角色卡里写了 system_prompt 时优先用角色卡的（可用 {{original}} 引用预设里的原文） */
  preferCharPrompt: z.boolean().default(true),
  /** 角色卡里写了 post_history_instructions 时优先用角色卡的 */
  preferCharInstructions: z.boolean().default(true),
  /** 示例对话：gradual 预算不够时逐步丢弃；keep 总是保留；disabled 不发送 */
  exampleBehavior: z.enum(['gradual', 'keep', 'disabled']).default('gradual'),
  /** 把用户消息包在引号里。未实现（酒馆也已弃用，建议用正则扩展） */
  wrapInQuotes: z.boolean().default(false),
  /** 把 system 消息作为独立的系统指令字段发送（Claude / Gemini 原生接口专用）。未实现 */
  useSystemPrompt: z.boolean().default(false),
})
export type PresetBehavior = z.infer<typeof behaviorSchema>

export const DEFAULT_MAIN_PROMPT =
  '你正在和{{user}}进行一场沉浸式角色扮演。你扮演{{char}}，只描写{{char}}的言行与内心，' +
  '不要替{{user}}说话或做决定。保持人设一致，回复生动具体，推动情节发展。'

/** 新建预设时的默认 Prompt 顺序，和酒馆默认预设一致 */
export function defaultPromptBlocks(): PromptBlock[] {
  const block = (id: BuiltinPromptId, content = ''): PromptBlock =>
    promptBlockSchema.parse({ id, name: BUILTIN_PROMPTS[id].name, content })
  return [
    block('main', DEFAULT_MAIN_PROMPT),
    block('wi_before'),
    block('persona'),
    block('char_description'),
    block('char_personality'),
    block('scenario'),
    { ...block('enhance_definitions'), enabled: false },
    { ...block('auxiliary'), enabled: false },
    block('wi_after'),
    block('examples'),
    block('history'),
    block('post_history'),
  ]
}

export const presetDataSchema = z.object({
  samplers: samplerSchema.default(samplerSchema.parse({})),
  prompts: z.array(promptBlockSchema).default(defaultPromptBlocks),
  utility: utilityPromptsSchema.default(utilityPromptsSchema.parse({})),
  behavior: behaviorSchema.default(behaviorSchema.parse({})),
})
export type PresetData = z.infer<typeof presetDataSchema>

export interface PromptPresetDTO {
  id: string
  name: string
  data: PresetData
  isDefault: boolean
  updatedAt: number
}

export const promptPresetInput = z.object({
  name: z.string().trim().min(1),
  data: presetDataSchema,
})
export type PromptPresetInput = z.input<typeof promptPresetInput>
