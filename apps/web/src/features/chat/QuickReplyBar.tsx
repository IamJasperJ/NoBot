import { useState } from 'react'
import { cx } from '../../components/ui'
import { t } from '../../i18n'
import { useActiveQuickReplies, useRunQuickReply } from '../../quick-replies/hooks'
import { errorMessage, toast } from '../../stores/toast'

/**
 * 输入框上方的快速回复按钮条：全局 + 角色 + 会话启用的快速回复，一行横向滚动。
 * 点按钮执行（发消息或跑命令），执行中的按钮转圈
 */
export function QuickReplyBar({ chatId, disabled }: { chatId: string; disabled?: boolean }) {
  const active = useActiveQuickReplies(chatId)
  const run = useRunQuickReply(chatId)
  const [running, setRunning] = useState<string | null>(null)
  const list = active.data
  if (!list.length) return null
  return (
    <div className="chat-column mb-2 flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none]">
      {list.map((qr) => {
        const key = `${qr.set.id}:${qr.id}`
        return (
          <button
            key={key}
            type="button"
            title={qr.title || qr.message}
            disabled={disabled || running !== null}
            onClick={async () => {
              setRunning(key)
              try {
                await run(qr, qr.set)
              } catch (e) {
                toast.error(errorMessage(e))
              } finally {
                setRunning(null)
              }
            }}
            className={cx(
              'flex h-7 shrink-0 items-center gap-1 rounded-full border border-zinc-200 bg-white/80 px-3 text-xs whitespace-nowrap text-zinc-700 transition-colors hover:border-violet-300 hover:text-violet-700 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900/80 dark:text-zinc-300 dark:hover:border-violet-700 dark:hover:text-violet-300',
              running === key && 'border-violet-300 text-violet-700',
            )}
          >
            {running === key && (
              <span className="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
            )}
            {qr.icon && <span aria-hidden="true">{qr.icon}</span>}
            {qr.label || t('未命名')}
          </button>
        )
      })}
    </div>
  )
}
