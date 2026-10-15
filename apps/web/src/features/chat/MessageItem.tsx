import type { MessageDTO } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { memo, useState } from 'react'
import { api } from '../../api/client'
import { replaceMessage, resetChat } from '../../api/queries'
import { ChevronLeftIcon, ChevronRightIcon, EditIcon, RefreshIcon, TrashIcon } from '../../components/icons'
import { Avatar, Button, cx, IconButton, inputClass } from '../../components/ui'
import { useStreaming } from '../../stores/streaming'
import { errorMessage, toast } from '../../stores/toast'
import { FormattedText } from './format'
import { runGeneration } from './generate'

interface Props {
  msg: MessageDTO
  chatId: string
  isLast: boolean
  /** 会话里是否有正在进行的生成（生成中禁止改动消息树） */
  busy: boolean
  charName: string
  charAvatar: string | null
  userName: string
}

/**
 * 单条消息。用 memo 包起来，只有自己的数据变了才重新渲染。
 * 正在生成的那条消息额外订阅 streaming store 里的文本。
 */
export const MessageItem = memo(function MessageItem({
  msg,
  chatId,
  isLast,
  busy,
  charName,
  charAvatar,
  userName,
}: Props) {
  const qc = useQueryClient()
  const liveText = useStreaming((s) => (s.messageId === msg.id ? s.text : null))
  const liveReasoning = useStreaming((s) => (s.messageId === msg.id ? s.reasoning : null))
  const [editing, setEditing] = useState<string | null>(null)

  const isUser = msg.role === 'user'
  const isStreaming = liveText !== null || msg.status === 'streaming'
  const text = liveText ?? msg.content
  const reasoning = liveReasoning || msg.meta.reasoning
  // 最后一条角色回复可以向右滑出新的回复；其他消息只能在已有的 swipe 间切换
  const canRegenerate = isLast && msg.role === 'assistant' && msg.parentId !== null

  const regenerate = () =>
    runGeneration(qc, chatId, { mode: 'regenerate', targetId: msg.id }).catch((e) => toast.error(errorMessage(e)))

  const swipe = async (direction: -1 | 1) => {
    if (direction === 1 && msg.swipeIndex === msg.swipeCount) {
      if (canRegenerate) await regenerate()
      return
    }
    try {
      await api.swipe(chatId, { messageId: msg.id, direction })
      await resetChat(qc, chatId)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const saveEdit = async () => {
    if (editing === null) return
    try {
      replaceMessage(qc, chatId, await api.editMessage(msg.id, editing))
      setEditing(null)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const remove = async () => {
    if (!confirm('删除这条消息？它后面的所有分支也会一起删除。')) return
    try {
      await api.deleteMessage(msg.id)
      await resetChat(qc, chatId)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const showSwipes = msg.swipeCount > 1 || canRegenerate

  return (
    <div className="group flex gap-3 px-4 py-3">
      <Avatar name={isUser ? userName : charName} url={isUser ? null : charAvatar} />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-sm">
          <span className="font-semibold">{isUser ? userName : charName}</span>
          {msg.status === 'aborted' && <span className="text-xs text-zinc-400">已中止</span>}
          {/* 操作按钮：鼠标移上来才显示；触屏设备上一直显示 */}
          {!isStreaming && editing === null && (
            <div className="ml-auto flex opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
              <IconButton label="编辑" onClick={() => setEditing(msg.content)} disabled={busy}>
                <EditIcon />
              </IconButton>
              {canRegenerate && (
                <IconButton label="重新生成" onClick={regenerate} disabled={busy}>
                  <RefreshIcon />
                </IconButton>
              )}
              <IconButton label="删除" onClick={remove} disabled={busy}>
                <TrashIcon />
              </IconButton>
            </div>
          )}
        </div>

        {reasoning && (
          <details className="mb-2 rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-500 dark:bg-zinc-900">
            <summary className="cursor-pointer select-none">{isStreaming && !text ? '思考中…' : '思考过程'}</summary>
            <div className="mt-2 whitespace-pre-wrap">{reasoning}</div>
          </details>
        )}

        {editing !== null ? (
          <div className="space-y-2">
            <textarea
              className={`${inputClass} min-h-32`}
              value={editing}
              onChange={(e) => setEditing(e.target.value)}
              // biome-ignore lint/a11y/noAutofocus: 点了编辑就该直接能输入
              autoFocus
            />
            <div className="flex gap-2">
              <Button variant="primary" onClick={saveEdit}>
                保存
              </Button>
              <Button onClick={() => setEditing(null)}>取消</Button>
            </div>
          </div>
        ) : (
          <div className={cx(isUser && 'text-zinc-800 dark:text-zinc-200', isStreaming && 'streaming-cursor')}>
            <FormattedText text={text} />
          </div>
        )}

        {msg.status === 'error' && (
          <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            生成失败：{msg.meta.error}
          </div>
        )}

        {showSwipes && !isStreaming && (
          <div className="mt-1 flex items-center gap-1 text-xs text-zinc-500">
            <IconButton label="上一个回复" onClick={() => swipe(-1)} disabled={busy || msg.swipeIndex <= 1}>
              <ChevronLeftIcon />
            </IconButton>
            <span className="tabular-nums">
              {msg.swipeIndex} / {msg.swipeCount}
            </span>
            <IconButton
              label={msg.swipeIndex === msg.swipeCount ? '生成新回复' : '下一个回复'}
              onClick={() => swipe(1)}
              disabled={busy || (msg.swipeIndex === msg.swipeCount && !canRegenerate)}
            >
              <ChevronRightIcon />
            </IconButton>
          </div>
        )}
      </div>
    </div>
  )
})
