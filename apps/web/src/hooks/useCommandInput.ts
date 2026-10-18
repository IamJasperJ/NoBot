import { useQueryClient } from '@tanstack/react-query'
import { useState, useSyncExternalStore } from 'react'
import { registerBuiltins } from '../commands/builtins'
import { createCommandContext } from '../commands/context'
import { splitPipeline } from '../commands/parser'
import { commandVersion, getCommand, searchCommands, subscribeCommands } from '../commands/registry'
import { runCommandLine } from '../commands/run'
import { t } from '../i18n'
import { useUi } from '../stores/ui'

registerBuiltins()
export function useCommandInput(text: string) {
  const qc = useQueryClient()
  const chatId = useUi((s) => s.chatId)
  useSyncExternalStore(subscribeCommands, commandVersion, commandVersion)
  const [executionError, setError] = useState<string | null>(null)
  const isCommand = text.trimStart().startsWith('/')
  let error: string | null = null
  let segment = text
  if (isCommand) {
    try {
      segment = splitPipeline(text).at(-1)?.trimStart() ?? ''
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }
  const typing = isCommand && /^\/[^\s]*$/.test(segment)
  const name = segment.match(/^\/([^\s]*)/)?.[1] ?? ''
  const suggestions = isCommand ? searchCommands(name) : []
  const command = getCommand(name)
  const argName = segment.match(/\s([\w-]+)=(?:[^\s]*|"[^"]*|'[^']*)$/)?.[1]
  const activeArg = command?.args.find((arg) => arg.name === argName) ?? null
  if (isCommand && !error && /\s/.test(segment) && !command) error = t('未知命令：{name}', { name })
  const execute = async (source: string) => {
    setError(null)
    try {
      return await runCommandLine(source, createCommandContext(qc, chatId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      throw e
    }
  }
  const complete = (name: string): string => {
    if (!isCommand) return text
    let parts: string[]
    try {
      parts = splitPipeline(text)
    } catch {
      return text
    }
    const last = parts.pop() ?? ''
    parts.push(last.replace(/^(\s*)\/[^\s]*(?:\s*)/, `$1/${name} `))
    return parts.join('|')
  }
  return {
    isCommand,
    typing,
    command: !typing && isCommand ? command : undefined,
    complete,
    suggestions,
    activeArg,
    error: error ?? executionError,
    execute,
  }
}
