import type { GenerateInput, QuickReplySet } from '@ai-parter/shared'
import type { api } from '../api/client'
import { t } from '../i18n'
import { parseCommandLine } from './parser'
import { getCommand } from './registry'

export interface CommandContext {
  chatId: string | null
  api: typeof api
  generate: (chatId: string, input: GenerateInput) => Promise<void>
  refresh: () => Promise<void>
  getInput: () => string
  setInput: (text: string) => void
  notify: (text: string) => void
  prompt: (text: string) => Promise<string | null>
  getActiveSets: () => Promise<QuickReplySet[]>
  depth?: number
  automationDepth?: number
}
export function requireChat(ctx: CommandContext): string {
  if (!ctx.chatId) throw new Error(t('请先打开会话'))
  return ctx.chatId
}
export async function runCommandLine(text: string, ctx: CommandContext): Promise<string> {
  if ((ctx.depth ?? 0) >= 16) throw new Error(t('命令嵌套过深'))
  let pipe = ''
  const parsed = (() => {
    try {
      return parseCommandLine(text)
    } catch (error) {
      const name = text.trimStart().match(/^\/([\w-]+)/)?.[1] ?? ''
      throw new Error(`/${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  })()
  for (const [index, item] of parsed.entries()) {
    try {
      const command = getCommand(item.name)
      if (!command) throw new Error(t('未知命令：{name}', { name: item.name }))
      const explicit = item.text.includes('{{pipe}}') || Object.values(item.args).some((s) => s.includes('{{pipe}}'))
      const replace = (value: string) => value.replaceAll('{{pipe}}', pipe)
      const args = Object.fromEntries(Object.entries(item.args).map(([k, v]) => [k, replace(v)]))
      for (const arg of command.args) {
        const value = args[arg.name]
        if (arg.required && value === undefined) throw new Error(t('缺少参数：{name}', { name: arg.name }))
        if (value === undefined) continue
        if (
          (arg.type === 'number' && (value.trim() === '' || !Number.isFinite(Number(value)))) ||
          (arg.type === 'boolean' && !['true', 'false'].includes(value)) ||
          (arg.enum && !arg.enum.includes(value))
        )
          throw new Error(t('参数无效：{name}', { name: arg.name }))
      }
      pipe =
        (await command.run(
          { ...ctx, depth: (ctx.depth ?? 0) + 1 },
          args,
          index > 0 && !explicit ? [item.text, pipe].filter(Boolean).join(' ') : replace(item.text),
        )) ?? ''
    } catch (error) {
      throw new Error(`/${item.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }
  return pipe
}
