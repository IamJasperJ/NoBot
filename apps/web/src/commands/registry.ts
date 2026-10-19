import type { CommandDescription } from '@nobot/shared'
import { t } from '../i18n'
import type { CommandContext } from './run'

export interface SlashCommand extends CommandDescription {
  // biome-ignore lint/suspicious/noConfusingVoidType: 命令允许只产生副作用，保持扩展实现的 void 返回类型。
  run: (ctx: CommandContext, args: Record<string, string>, text: string) => Promise<string | void>
}
const commands = new Map<string, SlashCommand>()
const listeners = new Set<() => void>()
let version = 0
export const commandVersion = () => version
export function subscribeCommands(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function changed() {
  version++
  for (const listener of listeners) listener()
}
export function registerCommand(command: SlashCommand): () => void {
  const names = [command.name, ...(command.aliases ?? [])].map((n) => n.toLowerCase())
  if (new Set(names).size !== names.length || names.some((n) => !/^[\w-]+$/.test(n) || commands.has(n))) {
    throw new Error(t('命令名称重复或无效：{name}', { name: command.name }))
  }
  for (const name of names) commands.set(name, command)
  changed()
  return () => {
    for (const name of names) if (commands.get(name) === command) commands.delete(name)
    changed()
  }
}
export const getCommand = (name: string) => commands.get(name.replace(/^\//, '').toLowerCase())
/** 别名单独列出，同时保留原始命令描述，补全可以显示实际命中的名字。 */
export const listCommands = () => [...commands].map(([name, command]) => ({ ...command, name, command }))
export const searchCommands = (prefix: string) =>
  listCommands().filter((item) => item.name.startsWith(prefix.replace(/^\//, '').toLowerCase()))
