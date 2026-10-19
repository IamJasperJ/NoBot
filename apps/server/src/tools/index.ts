import { describeCheck, formatDice, rollDice as rollDetailedDice } from '@nobot/core/stage'
import type { MessageMeta, ToolInfo } from '@nobot/shared'
import type { ExtensionContext } from '../extensions/types'
import { chatRules, performCheck } from '../services/trpg'

/**
 * 工具调用（function calling）。
 *
 * 模型在回复里请求调用工具 → 后端执行 → 结果作为 role=tool 的消息挂在消息树上 → 模型接着写。
 * 工具结果是消息树上的节点，所以重新生成、切换分支时，工具带来的状态变化也跟着回退：
 * 「当前跑团状态」= 激活路径上所有 tool 消息的 varsPatch 依次合并的结果（见 services/chats.ts 的 computeVars）。
 */

export interface ToolContext {
  /** 扩展工具独有的宿主和设置，chatId 与当前调用一致。 */
  extension?: ExtensionContext
  chatId: string
  /** 调用前的会话变量（沿激活路径累加得到） */
  vars: Record<string, unknown>
  random?: () => number
}

export interface ToolResult {
  /** 浅合并进已保存工具消息的元数据，数组整体替换。 */
  meta?: Partial<MessageMeta>
  /** 入库后调用；异步任务可以用宿主更新该消息。 */
  onSaved?: (messageId: string) => void
  /** 返回给模型的文本 */
  content: string
  /** 对会话变量的修改，会存进 tool 消息的 meta.varsPatch。值为 null 表示删除这个键 */
  varsPatch?: Record<string, unknown>
}

export interface ToolDefinition {
  name: string
  description: string
  /** 参数的 JSON Schema（OpenAI function calling 格式） */
  parameters: Record<string, unknown>
  run: (args: Record<string, unknown>, ctx: ToolContext) => ToolResult | Promise<ToolResult>
}

// ---- 内置工具 ----

/** 掷骰：支持 1d20、2d6+3、d100，返回每颗骰子的点数和总和 */
export function rollExpression(expr: string, random: () => number = Math.random) {
  const result = rollDetailedDice(expr, random)
  if (!result) return null
  return {
    rolls: result.groups.flatMap((group) => group.rolls.filter((roll) => roll.kept).map((roll) => roll.value)),
    bonus: result.modifier,
    total: result.total,
    dice: result,
  }
}

const rollDice: ToolDefinition = {
  name: 'roll_dice',
  description:
    'Roll dice. You must call this tool for random RPG outcomes (attacks, checks, damage, etc.); never invent results.',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Dice expression, e.g. 1d20, 2d6+3, 1d100' },
      reason: { type: 'string', description: 'Purpose of the roll, e.g. a Strength check' },
    },
    required: ['expression'],
  },
  run(args, ctx) {
    const expr = String(args.expression ?? '')
    const result = rollExpression(expr, ctx.random)
    if (!result) return { content: `Invalid dice expression "${expr}". Use a format such as 1d20 or 2d6+3.` }
    if (typeof args.reason === 'string') result.dice.reason = args.reason
    return {
      content: `${formatDice(result.dice)}${result.dice.reason ? ` (${result.dice.reason})` : ''}`,
      meta: { dice: result.dice },
    }
  },
}

const abilityCheck: ToolDefinition = {
  name: 'ability_check',
  description:
    'Call for ability, skill, or saving throw checks; never invent dice results. Use player for the player, a party member name, or an NPC name. DC reference: 5 very easy, 10 easy, 15 medium, 20 hard, 25 very hard, 30 nearly impossible. Omit DC for an opposed or open check.',
  parameters: {
    type: 'object',
    properties: {
      who: { type: 'string', description: 'Actor name, player, or me; defaults to player.' },
      skill: { type: 'string', description: 'English skill or ability name, or an ability followed by save.' },
      dc: { type: 'integer', minimum: 0, maximum: 100 },
      advantage: { type: 'string', enum: ['advantage', 'disadvantage'] },
    },
    required: ['skill'],
  },
  run(args, ctx) {
    if (!chatRules(ctx.chatId)) return { content: 'This chat has no enabled, implemented RPG rule system.' }
    if (typeof args.skill !== 'string' || !args.skill.trim()) return { content: 'A skill or ability is required.' }
    if (
      args.dc !== undefined &&
      (typeof args.dc !== 'number' || !Number.isInteger(args.dc) || args.dc < 0 || args.dc > 100)
    )
      return { content: 'DC must be an integer from 0 to 100.' }
    const result = performCheck(
      ctx.chatId,
      {
        who: typeof args.who === 'string' ? args.who : undefined,
        skill: args.skill,
        dc: typeof args.dc === 'number' ? args.dc : null,
        advantage: args.advantage === 'advantage' || args.advantage === 'disadvantage' ? args.advantage : undefined,
      },
      ctx.vars,
      ctx.random,
    )
    return { content: describeCheck(result), meta: { check: result } }
  },
}

const getTime: ToolDefinition = {
  name: 'get_current_time',
  description: 'Get the current real-world date and time.',
  parameters: { type: 'object', properties: {} },
  run: () => ({ content: new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' }) }),
}

const getState: ToolDefinition = {
  name: 'get_chat_state',
  description: 'Read saved state variables for the current chat (e.g. character HP, inventory, quest progress).',
  parameters: { type: 'object', properties: {} },
  run: (_args, ctx) => ({
    content:
      Object.keys(ctx.vars).length > 0 ? JSON.stringify(ctx.vars, null, 2) : 'No state variables are currently saved.',
  }),
}

const setState: ToolDefinition = {
  name: 'set_chat_state',
  description:
    'Set persistent chat state variables such as HP, inventory, gold, or quest progress. Set value to null to delete the variable.',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Variable name, e.g. Traveler.HP or inventory' },
      value: { description: 'New value: a number, text, list, or object; null deletes the variable' },
    },
    required: ['key', 'value'],
  },
  run(args, ctx) {
    const key = String(args.key ?? '').trim()
    if (!key) return { content: 'Variable name cannot be empty.' }
    const before = ctx.vars[key]
    const value = args.value ?? null
    return {
      content: `${key}：${before === undefined ? '(none)' : JSON.stringify(before)} → ${value === null ? '(deleted)' : JSON.stringify(value)}`,
      varsPatch: { [key]: value },
    }
  },
}

export const BUILTIN_TOOLS: ToolDefinition[] = [rollDice, abilityCheck, getTime, getState, setState]

/** 当前可用的全部工具：内置 + 已启用扩展提供的。扩展注册表在启动时注入，避免循环依赖 */
let extensionToolsProvider: (chatId?: string) => { tool: ToolDefinition; source: string }[] = () => []
export function setExtensionToolsProvider(fn: typeof extensionToolsProvider) {
  extensionToolsProvider = fn
}

export function availableTools(chatId?: string): { tool: ToolDefinition; source: string }[] {
  const all = [...BUILTIN_TOOLS.map((tool) => ({ tool, source: 'builtin' })), ...extensionToolsProvider(chatId)]
  // 同名工具以先注册的为准
  const seen = new Set<string>()
  return all.filter(({ tool }) => {
    if (tool.name === 'ability_check' && chatId && !chatRules(chatId)) return false
    if (seen.has(tool.name)) return false
    seen.add(tool.name)
    return true
  })
}

export function listToolInfo(): ToolInfo[] {
  return availableTools().map(({ tool, source }) => ({ name: tool.name, description: tool.description, source }))
}

/** 转成 OpenAI 请求体里的 tools 字段。disabled 是生成预设里单独关闭的工具 */
export function toOpenAITools(disabled: string[] = [], chatId?: string) {
  return availableTools(chatId)
    .filter(({ tool }) => !disabled.includes(tool.name))
    .map(({ tool }) => ({
      type: 'function' as const,
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
}

export async function runTool(
  name: string,
  rawArgs: string,
  ctx: ToolContext,
  disabled: string[] = [],
): Promise<ToolResult> {
  // 模型偶尔会调用没提供给它的工具，关闭的工具一律拒绝执行
  if (disabled.includes(name)) return { content: `Tool ${name} is disabled.` }
  const found = availableTools(ctx.chatId).find(({ tool }) => tool.name === name)
  if (!found) return { content: `No tool named ${name} exists.` }
  let args: Record<string, unknown> = {}
  try {
    const parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
  } catch {
    return { content: `Tool arguments are not valid JSON: ${rawArgs.slice(0, 200)}` }
  }
  try {
    return await found.tool.run(args, ctx)
  } catch (e) {
    return { content: `Tool execution failed (${e instanceof Error ? e.name : 'unknown error'}).` }
  }
}

/** 历史过滤和请求定义共用按会话解析后的工具列表。 */
export function enabledToolNames(chatId: string, samplers: { functionCalling: boolean; disabledTools: string[] }) {
  return samplers.functionCalling ? toOpenAITools(samplers.disabledTools, chatId).map((item) => item.function.name) : []
}
