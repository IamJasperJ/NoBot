import { defineExtension, type ExtensionContext } from '../types'

/**
 * 内置扩展：正则替换（对应酒馆最常用的 Regex 扩展）。
 * 每条规则可以作用于：用户输入（入库前）、AI 输出（入库前）、发送的 Prompt（不改聊天记录）。
 */

interface RegexScript {
  name: string
  /** 形如 /pattern/flags 按正则；否则按普通文本全部替换 */
  find: string
  /** 替换文本，正则时支持 $1、$<name> 等写法 */
  replace: string
  input: boolean
  output: boolean
  prompt: boolean
  enabled: boolean
}

function scriptsOf(ctx: ExtensionContext): RegexScript[] {
  const list = ctx.settings.scripts
  return Array.isArray(list) ? (list as RegexScript[]) : []
}

/** 把规则编译成正则。写错的正则跳过（不让一条坏规则影响聊天） */
function compile(find: string): RegExp | null {
  const m = find.match(/^\/(.+)\/([a-z]*)$/s)
  try {
    if (m) return new RegExp(m[1] as string, m[2])
    if (!find) return null
    return new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  } catch {
    return null
  }
}

function apply(text: string, ctx: ExtensionContext, where: 'input' | 'output' | 'prompt'): string {
  let result = text
  for (const s of scriptsOf(ctx)) {
    if (!s.enabled || !s[where]) continue
    const re = compile(s.find)
    if (re) result = result.replace(re, s.replace ?? '')
  }
  return result
}

export default defineExtension({
  id: 'regex',
  name: '正则替换',
  description: '用正则表达式改写用户输入、AI 输出或发送给模型的 Prompt。比如去掉多余的星号、统一引号。',
  version: '1.0.0',
  enabledByDefault: true,
  defaultSettings: { scripts: [] },
  settingsSchema: [
    {
      key: 'scripts',
      titleKey: 'name',
      label: '规则',
      type: 'list',
      hint: '按顺序执行。查找写成 /正则/标志 按正则匹配，否则按普通文本全部替换；替换里可用 $1 引用分组。',
      itemFields: [
        { key: 'name', label: '名称', type: 'string' },
        { key: 'find', label: '查找', type: 'string' },
        { key: 'replace', label: '替换为', type: 'string' },
        { key: 'input', label: '作用于用户输入', type: 'boolean' },
        { key: 'output', label: '作用于 AI 输出', type: 'boolean' },
        { key: 'prompt', label: '只改发送的 Prompt', type: 'boolean' },
        { key: 'enabled', label: '启用', type: 'boolean' },
      ],
    },
  ],
  hooks: {
    transformInput: (text, ctx) => apply(text, ctx, 'input'),
    transformOutput: (text, ctx) => apply(text, ctx, 'output'),
    afterPrompt: (messages, ctx) =>
      messages.map((m) =>
        m.role === 'user' || m.role === 'assistant' ? { ...m, content: apply(m.content, ctx, 'prompt') } : m,
      ),
  },
})
