import type { BuildReport, CharacterFields, ChatMessage, MessageRole, PromptSegment } from '@ai-parter/shared'
import { countTokens, MESSAGE_OVERHEAD_TOKENS } from '../tokenizer'
import { applyMacros, type MacroContext } from './macros'

/**
 * Prompt 组装（里程碑 2 版本：固定顺序）。
 *
 * 这是一个纯函数：不读数据库、不发网络请求，同样的输入永远得到同样的输出。
 * 预览和真实发送调用的是同一个函数。
 *
 * 当前顺序：
 *   主系统提示 → 角色描述 → 性格 → 场景 → 用户人设
 *   → 示例对话（有预算才放）→ 历史消息（从新到旧填满预算）→ 历史后指令
 * 作者注释按深度插在历史消息中间。
 * 里程碑 4 会把顺序改成由 Prompt 预设决定。
 */

export interface PromptContext {
  character: CharacterFields
  persona: { name: string; description: string }
  /** 当前激活路径，从根到叶 */
  history: { id: string; role: MessageRole; content: string }[]
  api: { contextSize: number; maxTokens: number }
  chat: { id: string; leafId: string | null; authorNote: string; authorNoteDepth: number }
  /** 从外部传入，保证结果可复现 */
  now: Date
  /** 角色卡没写 system_prompt 时用的主提示 */
  defaultMainPrompt?: string
}

export class PromptBudgetError extends Error {}

export const DEFAULT_MAIN_PROMPT =
  '你正在和{{user}}进行一场沉浸式角色扮演。你扮演{{char}}，只描写{{char}}的言行与内心，' +
  '不要替{{user}}说话或做决定。保持人设一致，回复生动具体，推动情节发展。'

/** 预留 5% 余量，抵消不同模型 tokenizer 的差异 */
const SAFETY_RATIO = 0.95

function segment(source: string, role: MessageRole, content: string, messageId?: string): PromptSegment {
  return {
    source,
    role,
    content,
    tokens: countTokens(content) + MESSAGE_OVERHEAD_TOKENS,
    ...(messageId ? { messageId } : {}),
  }
}

/** 按 <START> 切分示例对话 */
export function splitExamples(mesExample: string): string[] {
  return mesExample
    .split(/<START>/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function buildPrompt(ctx: PromptContext): { messages: ChatMessage[]; report: BuildReport } {
  const { character: c, persona } = ctx
  const macro: MacroContext = {
    char: c.name,
    user: persona.name,
    now: ctx.now,
    seed: `${ctx.chat.id}|${ctx.chat.leafId ?? ''}`,
  }
  const m = (text: string) => applyMacros(text, macro).trim()

  // ---- 1. 固定片段：不截断 ----
  const head: PromptSegment[] = []
  const main = m(c.system_prompt || ctx.defaultMainPrompt || DEFAULT_MAIN_PROMPT)
  if (main) head.push(segment('main', 'system', main))
  if (c.description.trim()) head.push(segment('char_description', 'system', m(c.description)))
  if (c.personality.trim()) {
    head.push(segment('char_personality', 'system', `${c.name}的性格：${m(c.personality)}`))
  }
  if (c.scenario.trim()) head.push(segment('scenario', 'system', `场景：${m(c.scenario)}`))
  if (persona.description.trim()) {
    head.push(segment('persona', 'system', `关于${persona.name}：${m(persona.description)}`))
  }

  const tail: PromptSegment[] = []
  if (c.post_history_instructions.trim()) {
    tail.push(segment('post_history', 'system', m(c.post_history_instructions)))
  }

  const authorNote = ctx.chat.authorNote.trim() ? segment('author_note', 'system', m(ctx.chat.authorNote)) : null

  const budget = Math.floor((ctx.api.contextSize - ctx.api.maxTokens) * SAFETY_RATIO)
  const fixedTokens = [...head, ...tail, ...(authorNote ? [authorNote] : [])].reduce((n, s) => n + s.tokens, 0)
  if (fixedTokens > budget) {
    throw new PromptBudgetError(
      `固定部分已有 ${fixedTokens} token，超过可用预算 ${budget}。请调大上下文长度或缩短角色设定。`,
    )
  }
  let remaining = budget - fixedTokens

  // ---- 2. 历史消息：从最新往旧填，直到预算用完 ----
  const keptHistory: PromptSegment[] = []
  for (let i = ctx.history.length - 1; i >= 0; i--) {
    const msg = ctx.history[i] as PromptContext['history'][number]
    const seg = segment('history', msg.role, m(msg.content), msg.id)
    if (seg.tokens > remaining) break
    remaining -= seg.tokens
    keptHistory.unshift(seg)
  }

  // ---- 3. 示例对话：有剩余预算才放 ----
  const examples: PromptSegment[] = []
  for (const block of splitExamples(c.mes_example)) {
    const seg = segment('examples', 'system', `对话示例：\n${m(block)}`)
    if (seg.tokens > remaining) break
    remaining -= seg.tokens
    examples.push(seg)
  }

  // ---- 4. 作者注释按深度插入：插在倒数第 depth 条历史之前 ----
  const historyWithNote = [...keptHistory]
  if (authorNote) {
    const at = Math.max(0, historyWithNote.length - ctx.chat.authorNoteDepth)
    historyWithNote.splice(at, 0, authorNote)
  }

  const segments = [...head, ...examples, ...historyWithNote, ...tail]
  return {
    messages: normalize(segments),
    report: {
      segments,
      totalTokens: segments.reduce((n, s) => n + s.tokens, 0),
      budget,
      historyTotal: ctx.history.length,
      historyKept: keptHistory.length,
    },
  }
}

/** 去掉空片段，合并相邻的同角色消息（有些接口要求 user / assistant 严格交替） */
function normalize(segments: PromptSegment[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const s of segments) {
    if (!s.content) continue
    const last = out.at(-1)
    if (last && last.role === s.role) last.content += `\n\n${s.content}`
    else out.push({ role: s.role, content: s.content })
  }
  return out
}
