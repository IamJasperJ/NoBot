import type { MessageMeta, ToolInfo } from '@ai-parter/shared'
import type { ExtensionContext } from '../extensions/types'

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
  const m = expr.replace(/\s/g, '').match(/^(\d*)d(\d+)([+-]\d+)?$/i)
  if (!m) return null
  const count = Math.min(Math.max(Number(m[1] || 1), 1), 100)
  const sides = Number(m[2])
  if (sides < 2 || sides > 1000) return null
  const bonus = m[3] ? Number(m[3]) : 0
  const rolls = Array.from({ length: count }, () => 1 + Math.floor(random() * sides))
  return { rolls, bonus, total: rolls.reduce((a, b) => a + b, 0) + bonus }
}

const rollDice: ToolDefinition = {
  name: 'roll_dice',
  description: '掷骰子。跑团中需要随机判定（攻击、检定、伤害等）时必须调用，不要自己编造结果。',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '骰子表达式，如 1d20、2d6+3、1d100' },
      reason: { type: 'string', description: '这次掷骰的目的，如「力量检定」' },
    },
    required: ['expression'],
  },
  run(args) {
    const expr = String(args.expression ?? '')
    const result = rollExpression(expr)
    if (!result) return { content: `骰子表达式「${expr}」不合法，请用类似 1d20、2d6+3 的格式` }
    const reason = args.reason ? `（${String(args.reason)}）` : ''
    const detail = result.rolls.join('、') + (result.bonus ? `，${result.bonus > 0 ? '+' : ''}${result.bonus}` : '')
    return { content: `${expr}${reason} = ${result.total}（${detail}）` }
  },
}

const getTime: ToolDefinition = {
  name: 'get_current_time',
  description: '获取现实世界的当前日期和时间。',
  parameters: { type: 'object', properties: {} },
  run: () => ({ content: new Date().toLocaleString('zh-CN', { dateStyle: 'full', timeStyle: 'short' }) }),
}

const getState: ToolDefinition = {
  name: 'get_chat_state',
  description: '读取当前会话保存的状态变量（如角色 HP、背包、任务进度）。',
  parameters: { type: 'object', properties: {} },
  run: (_args, ctx) => ({
    content: Object.keys(ctx.vars).length > 0 ? JSON.stringify(ctx.vars, null, 2) : '当前没有任何状态变量',
  }),
}

const setState: ToolDefinition = {
  name: 'set_chat_state',
  description: '设置会话状态变量，用于记录 HP、背包、金币、任务进度等需要长期保持的数值。value 为 null 时删除该变量。',
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string', description: '变量名，如「旅人.HP」「背包」' },
      value: { description: '新的值，可以是数字、文本、列表或对象；null 表示删除' },
    },
    required: ['key', 'value'],
  },
  run(args, ctx) {
    const key = String(args.key ?? '').trim()
    if (!key) return { content: '变量名不能为空' }
    const before = ctx.vars[key]
    const value = args.value ?? null
    return {
      content: `${key}：${before === undefined ? '（无）' : JSON.stringify(before)} → ${value === null ? '（已删除）' : JSON.stringify(value)}`,
      varsPatch: { [key]: value },
    }
  },
}

export const BUILTIN_TOOLS: ToolDefinition[] = [rollDice, getTime, getState, setState]

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
  if (disabled.includes(name)) return { content: `工具 ${name} 已被关闭` }
  const found = availableTools(ctx.chatId).find(({ tool }) => tool.name === name)
  if (!found) return { content: `没有名为 ${name} 的工具` }
  let args: Record<string, unknown> = {}
  try {
    const parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
  } catch {
    return { content: `工具参数不是合法的 JSON：${rawArgs.slice(0, 200)}` }
  }
  try {
    return await found.tool.run(args, ctx)
  } catch (e) {
    return { content: `工具执行出错：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 历史过滤和请求定义共用按会话解析后的工具列表。 */
export function enabledToolNames(chatId: string, samplers: { functionCalling: boolean; disabledTools: string[] }) {
  return samplers.functionCalling ? toOpenAITools(samplers.disabledTools, chatId).map((item) => item.function.name) : []
}
