import type { MessageDTO } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { memo, useState } from 'react'
import { api } from '../../api/client'
import { keys, replaceMessage, resetChat } from '../../api/queries'
import {
  BranchIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DotsIcon,
  EditIcon,
  LogIcon,
  RefreshIcon,
  TrashIcon,
} from '../../components/icons'
import { Avatar, Button, cx, IconButton, inputClass } from '../../components/ui'
import { transformMessage, useExtensionsRuntime } from '../../extensions/runtime'
import { Slot } from '../../extensions/Slot'
import { useStreaming } from '../../stores/streaming'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { FormattedText } from './format'
import { runGeneration } from './generate'

/** 会话里出场的人：角色（群聊里是全部成员）和用户人设 */
export interface ChatCast {
  speakers: Record<string, { name: string; avatarUrl: string | null }>
  /** 找不到发言人时（比如角色被删了）用它 */
  fallback: { name: string; avatarUrl: string | null }
  user: { name: string; avatarUrl: string | null }
}

interface Props {
  msg: MessageDTO
  chatId: string
  isLast: boolean
  /** 会话里是否有正在进行的生成（生成中禁止改动消息树） */
  busy: boolean
  cast: ChatCast
}

/** 工具调用的结果：显示成一张紧凑的小卡片 */
function ToolMessage({ msg, chatId, text }: { msg: MessageDTO; chatId: string; text: string }) {
  const label = msg.meta.toolName === 'roll_dice' ? '🎲 掷骰' : `🔧 ${msg.meta.toolName ?? '工具'}`
  return (
    <div className="px-4 py-1 pl-[68px]">
      <div className="inline-flex max-w-full items-start gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-900">
        <span className="shrink-0 font-medium text-zinc-500">{label}</span>
        <span className="min-w-0 break-words whitespace-pre-wrap">{text}</span>
      </div>
      <Slot name="chat.message.footer" props={{ chatId, message: msg }} />
    </div>
  )
}

/**
 * 单条消息。用 memo 包起来，只有自己的数据变了才重新渲染。
 * 正在生成的那条消息额外订阅 streaming store 里的文本。
 */
export const MessageItem = memo(function MessageItem({ msg, chatId, isLast, busy, cast }: Props) {
  const transforms = useExtensionsRuntime((s) => s.transforms)
  const qc = useQueryClient()
  const liveText = useStreaming((s) => (s.messageId === msg.id ? s.text : null))
  const liveReasoning = useStreaming((s) => (s.messageId === msg.id ? s.reasoning : null))
  const [editing, setEditing] = useState<string | null>(null)

  if (msg.role === 'tool')
    return <ToolMessage msg={msg} chatId={chatId} text={transformMessage(msg.content, msg, transforms)} />

  const isUser = msg.role === 'user'
  const speaker = msg.speakerId ? cast.speakers[msg.speakerId] : undefined
  const who = isUser ? cast.user : (speaker ?? { ...cast.fallback, name: msg.meta.name ?? cast.fallback.name })
  const isStreaming = liveText !== null || msg.status === 'streaming'
  const text = transformMessage(liveText ?? msg.content, msg, transforms)
  const reasoning = liveReasoning || msg.meta.reasoning
  // 最后一条角色回复可以向右滑出新的回复、可以续写；其他消息只能在已有的 swipe 间切换
  const isReply = msg.role === 'assistant' && msg.parentId !== null
  const canRegenerate = isLast && isReply

  const run = (input: Parameters<typeof runGeneration>[2]) =>
    runGeneration(qc, chatId, input).catch((e) => toast.error(errorMessage(e)))

  const swipe = async (direction: -1 | 1) => {
    if (direction === 1 && msg.swipeIndex === msg.swipeCount) {
      if (canRegenerate) await run({ mode: 'regenerate', targetId: msg.id })
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

  const branch = async () => {
    try {
      const chat = await api.branch(chatId, msg.id)
      const owner = chat.groupId ? { groupId: chat.groupId } : { characterId: chat.characterId as string }
      await qc.invalidateQueries({ queryKey: keys.chats(owner) })
      useUi.getState().openChat(owner, chat.id)
      toast.info('已创建分支会话')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const showSwipes = msg.swipeCount > 1 || canRegenerate

  return (
    <div className="group flex gap-3 px-4 py-3">
      <Avatar name={who.name} url={who.avatarUrl} />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-sm">
          <span className="font-semibold">{who.name}</span>
          {msg.status === 'aborted' && <span className="text-xs text-zinc-400">已中止</span>}
          {msg.meta.toolCalls && msg.meta.toolCalls.length > 0 && (
            <span className="text-xs text-zinc-400">调用了 {msg.meta.toolCalls.map((c) => c.name).join('、')}</span>
          )}
          {/* 操作按钮：鼠标移上来才显示；触屏设备上一直显示 */}
          {!isStreaming && editing === null && (
            <div className="ml-auto flex items-center opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:has-[details[open]]:opacity-100">
              <IconButton label="编辑" onClick={() => setEditing(msg.content)} disabled={busy}>
                <EditIcon />
              </IconButton>
              {canRegenerate && (
                <IconButton
                  label="重新生成"
                  onClick={() => run({ mode: 'regenerate', targetId: msg.id })}
                  disabled={busy}
                >
                  <RefreshIcon />
                </IconButton>
              )}
              <details className="relative">
                <summary className="list-none">
                  <span className="inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800">
                    <DotsIcon />
                  </span>
                </summary>
                <div className="absolute right-0 z-20 mt-1 w-40 rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
                  {canRegenerate && (
                    <MenuItem
                      icon={<ChevronRightIcon />}
                      label="续写"
                      disabled={busy}
                      onClick={() => run({ mode: 'continue', targetId: msg.id })}
                    />
                  )}
                  <MenuItem icon={<BranchIcon />} label="从这里开分支" disabled={busy} onClick={branch} />
                  <MenuItem
                    icon={<CopyIcon />}
                    label="复制文本"
                    onClick={() => navigator.clipboard.writeText(msg.content).then(() => toast.info('已复制'))}
                  />
                  {msg.meta.logId && (
                    <MenuItem
                      icon={<LogIcon />}
                      label="查看请求"
                      onClick={() => useUi.getState().openView('logs', msg.meta.logId)}
                    />
                  )}
                  <Slot name="chat.message.actions" props={{ chatId, message: msg }} />
                  <MenuItem icon={<TrashIcon />} label="删除" danger disabled={busy} onClick={remove} />
                </div>
              </details>
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

        <Slot name="chat.message.footer" props={{ chatId, message: { ...msg, content: liveText ?? msg.content } }} />

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

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        // 点完菜单项后关掉菜单
        e.currentTarget.closest('details')?.removeAttribute('open')
        onClick()
      }}
      className={cx(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800',
        danger && 'text-red-600 dark:text-red-400',
      )}
    >
      <span className="text-zinc-400 [&>svg]:size-4">{icon}</span>
      {label}
    </button>
  )
}
