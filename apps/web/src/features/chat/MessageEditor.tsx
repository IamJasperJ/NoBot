import type { MessageDTO } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { refreshChatState, replaceMessage, resetChat } from '../../api/queries'
import { ArrowDownIcon, ArrowUpIcon } from '../../components/icons'
import { Button, IconButton, inputClass } from '../../components/ui'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'

/** 消息的编辑态：正文、思考过程，以及上移 / 下移（和酒馆一样放在编辑态） */
export function MessageEditor({
  msg,
  chatId,
  busy,
  onClose,
}: {
  msg: MessageDTO
  chatId: string
  busy: boolean
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [content, setContent] = useState(msg.content)
  // 编辑态里的思考过程：null 表示没有展开编辑（保存时不动它）
  const [reasoning, setReasoning] = useState<string | null>(msg.meta.reasoning ? msg.meta.reasoning : null)

  const save = async () => {
    try {
      // 思考过程：编辑框打开着就把框里的内容存回去（清空 = 删除）；没打开就不动它
      replaceMessage(qc, chatId, await api.editMessage(msg.id, content, reasoning ?? undefined))
      void refreshChatState(qc, chatId)
      onClose()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  // 上移 / 下移：在原位置生成一条交换了顺序的新分支，原来的顺序还能左右切换回去
  const move = async (direction: 'up' | 'down') => {
    if (content !== msg.content && !confirm(t('移动会放弃这次没保存的修改，继续？'))) return
    try {
      await api.moveMessage(chatId, msg.id, direction)
      onClose()
      await resetChat(qc, chatId)
      toast.info(direction === 'up' ? t('已上移，原来的顺序保留为另一个分支') : t('已下移，原来的顺序保留为另一个分支'))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <div className="space-y-2">
      {msg.role === 'assistant' &&
        (reasoning !== null ? (
          <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900/60">
            <div className="mb-1 flex items-center text-xs text-zinc-500">
              <span className="flex-1">{t('思考过程（清空后保存就删除）')}</span>
              <button
                type="button"
                className="rounded px-1.5 py-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-800"
                onClick={() => setReasoning('')}
              >
                {t('清空')}
              </button>
            </div>
            <textarea
              aria-label={t('思考过程')}
              className={`${inputClass} min-h-20 text-[13px]`}
              value={reasoning}
              onChange={(e) => setReasoning(e.target.value)}
            />
          </div>
        ) : (
          <button
            type="button"
            className="text-xs text-zinc-500 underline-offset-2 hover:text-violet-600 hover:underline"
            onClick={() => setReasoning(msg.meta.reasoning ?? '')}
          >
            {msg.meta.reasoning ? t('编辑思考过程') : t('+ 添加思考过程')}
          </button>
        ))}
      <textarea
        aria-label={t('消息内容')}
        className={`${inputClass} min-h-32`}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        // biome-ignore lint/a11y/noAutofocus: 点了编辑就该直接能输入
        autoFocus
      />
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={save}>
          {t('保存')}
        </Button>
        <Button onClick={onClose}>{t('取消')}</Button>
        {/* 带工具调用的消息不能移动 */}
        {!msg.meta.toolCalls?.length && (
          <div className="ml-auto flex items-center gap-0.5">
            <IconButton label={t('上移（原顺序保留为另一个分支）')} disabled={busy} onClick={() => void move('up')}>
              <ArrowUpIcon />
            </IconButton>
            <IconButton label={t('下移（原顺序保留为另一个分支）')} disabled={busy} onClick={() => void move('down')}>
              <ArrowDownIcon />
            </IconButton>
          </div>
        )}
      </div>
    </div>
  )
}
