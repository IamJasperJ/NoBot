import type { CommandArg, CommandDescription } from '@ai-parter/shared'
import { cx } from '../../components/ui'
import { t } from '../../i18n'

/**
 * 输入框上方的斜杠命令提示（纯展示，数据来自 useCommandInput）：
 * - 还在输命令名：列出匹配的命令，点一下或按 Tab 补全
 * - 命令名输完了：显示这个命令的用法，正在填的参数高亮
 * - 有错误：红字显示
 */
export function CommandHints({
  typing,
  suggestions,
  command,
  activeArg,
  error,
  onPick,
}: {
  /** 是否还在输命令名（还没有空格） */
  typing: boolean
  suggestions: (CommandDescription & { name: string })[]
  command: CommandDescription | undefined
  activeArg: CommandArg | null
  error: string | null
  onPick: (name: string) => void
}) {
  if (typing && suggestions.length > 0)
    return (
      <div className="chat-column mb-2 max-h-64 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
        {suggestions.slice(0, 30).map((item, i) => (
          <button
            key={item.name}
            type="button"
            // 失焦前就补全，不然点下去输入框先失焦
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(item.name)
            }}
            className={cx(
              'flex w-full items-baseline gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800',
              i === 0 && 'bg-zinc-50 dark:bg-zinc-800/60',
            )}
          >
            <code className="shrink-0 font-semibold text-violet-700 dark:text-violet-300">/{item.name}</code>
            <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">{item.description}</span>
            {i === 0 && <kbd className="shrink-0 text-[10px] text-zinc-400">Tab</kbd>}
          </button>
        ))}
      </div>
    )
  if (!command && !error) return null
  return (
    <div className="chat-column mb-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
      {command && (
        <>
          <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
            <code className="font-semibold text-violet-700 dark:text-violet-300">/{command.name}</code>
            {command.args.map((arg) => (
              <code
                key={arg.name}
                className={cx(
                  'rounded px-1',
                  arg.name === activeArg?.name
                    ? 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200'
                    : 'text-zinc-500',
                )}
              >
                {arg.required ? `${arg.name}=…` : `[${arg.name}=…]`}
              </code>
            ))}
            {command.unnamed && <code className="text-zinc-500">{t('[文本]')}</code>}
          </div>
          <p className="mt-1 text-zinc-500">
            {activeArg
              ? `${activeArg.name}：${activeArg.description}${activeArg.enum ? `（${activeArg.enum.join(' / ')}）` : ''}`
              : command.description}
          </p>
        </>
      )}
      {error && <p className="mt-1 text-red-600 dark:text-red-400">{error}</p>}
    </div>
  )
}
