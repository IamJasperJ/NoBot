import { toDisplayText } from '@ai-parter/core/stage'
import type { AttachmentDTO, ChoiceOption, MessageDTO } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { memo, useState } from 'react'
import { api } from '../../api/client'
import { keys, refreshChatState, replaceMessage, resetChat, useBookmarks, useSetAttachmentCg } from '../../api/queries'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BookmarkIcon,
  BranchIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DotsIcon,
  EditIcon,
  EyeIcon,
  EyeOffIcon,
  ListCheckIcon,
  LogIcon,
  RefreshIcon,
  StarIcon,
  TrashIcon,
} from '../../components/icons'
import { Avatar, Button, cx, IconButton, inputClass } from '../../components/ui'
import { emitClientEvent, hasListener, transformMessage, useExtensionsRuntime } from '../../extensions/runtime'
import { Slot } from '../../extensions/Slot'
import { t } from '../../i18n'
import { useChatOps } from '../../stores/chatOps'
import { useStreaming } from '../../stores/streaming'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { displayMacros, FormattedText } from './format'
import { runGeneration } from './generate'
import { ImagePromptDialog } from './ImagePromptDialog'

/** 会话里出场的人：角色（群聊里是全部成员）和用户人设 */
export interface ChatCast {
  speakers: Record<string, { name: string; avatarUrl: string | null }>
  /** 找不到发言人时（比如角色被删了）用它 */
  fallback: { name: string; avatarUrl: string | null }
  user: { name: string; avatarUrl: string | null }
  /** 玩法预设开了舞台指令时才有：怎么隐藏指令、要不要显示选项 */
  stage?: {
    knownNames: string[]
    narratorNames: string[]
    showSpeaker: boolean
    choices: boolean
  } | null
}

interface Props {
  msg: MessageDTO
  chatId: string
  isLast: boolean
  /** 会话里是否有正在进行的生成（生成中禁止改动消息树） */
  busy: boolean
  cast: ChatCast
}

/**
 * 非轮播图片的显示宽度：放进 320×320 的框里按原比例缩放。
 * 框的宽度必须明确给出，否则外层按图片的百分比 max-width 反推宽度，框会比图片宽、露出底色。
 */
function fitWidth(image: { width?: number | null; height?: number | null }) {
  if (!image.width || !image.height) return 'min(320px, 100%)'
  const width = Math.min(320, image.width, (320 * image.width) / image.height)
  return `min(${Math.round(width)}px, 100%)`
}

/** 媒体独立于工具正文显示，异步任务更新元数据后直接替换占位内容。 */
export function MessageMedia({ msg, chatId }: { msg: MessageDTO; chatId: string }) {
  const qc = useQueryClient()
  // 扩展热启停时重新判断「生成备选」是否可用
  useExtensionsRuntime((s) => s.listeners)
  const canGenerateAlternative = hasListener('image:swipe-next')
  const [saving, setSaving] = useState(false)
  const [editingPrompt, setEditingPrompt] = useState(false)
  const [expandedError, setExpandedError] = useState(false)
  const task = msg.meta.imageGen
  const images = msg.meta.images ?? []
  const hasTaskFrame = task?.status === 'pending' || task?.status === 'error'
  const count = images.length + (hasTaskFrame ? 1 : 0)
  const carousel = !!task && count > 0
  const imageIndex = Math.max(0, Math.min(msg.meta.imageIndex ?? count - 1, count - 1))
  const showTaskFrame = hasTaskFrame && imageIndex === images.length
  const imageAction = async (action: 'retry' | 'dismiss' | 'cancel', edited?: { prompt: string; negative: string }) => {
    if (saving) return
    if (action === 'dismiss' && !images.length && !confirm(t('放弃后将删除这条消息及后面的所有分支，确定放弃？')))
      return
    setSaving(true)
    try {
      const response = await fetch(`/api/ext/image-gen/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: msg.id, ...edited }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error?.message ?? t('图片操作失败'))
      if (data.message) replaceMessage(qc, chatId, data.message)
      if (data.deleted) await resetChat(qc, chatId)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  const switchImage = async (direction: -1 | 1) => {
    if (saving) return
    const next = imageIndex + direction
    // 和文字回复的切换一样：在最后一张再往右就是「生成备选图」（保留现有图片，再生成一张）
    if (next >= count) {
      if (!hasTaskFrame && canGenerateAlternative) emitClientEvent({ type: 'image:swipe-next', chatId, message: msg })
      return
    }
    if (next < 0) return
    setSaving(true)
    replaceMessage(qc, chatId, { ...msg, meta: { ...msg.meta, imageIndex: next } })
    try {
      replaceMessage(qc, chatId, await api.updateMessageImageIndex(msg.id, next))
    } catch (e) {
      replaceMessage(qc, chatId, msg)
      toast.error(errorMessage(e))
    } finally {
      setSaving(false)
    }
  }
  const ratio =
    task?.width && task.width > 0 && task.height && task.height > 0 ? `${task.width} / ${task.height}` : '1 / 1'
  // 生成的图片、占位框、失败框统一宽度，切换时不跳动
  const frameStyle = { width: 'min(320px, 100%)', aspectRatio: ratio }
  const stageText =
    task?.stage === 'prompt'
      ? t('正在写提示词…')
      : task?.stage === 'confirm'
        ? t('等待确认…')
        : task?.stage === 'queued'
          ? t('排队中 · 第 {position} 位', { position: task.queuePosition ?? 1 })
          : task?.stage === 'saving'
            ? t('保存中…')
            : t('生成中…')
  const cancelled = task?.error === t('已取消')
  // 没有图片也没有图片任务的消息不渲染这一块，避免在正文上方留出空白
  if (!images.length && !task) return null
  return (
    <div className="group/media my-2 space-y-1">
      {images.length > 0 && imageIndex < images.length && (
        <div className="flex flex-wrap gap-2">
          {images.map(
            (image, index) =>
              (!carousel || index === imageIndex) && (
                <a
                  key={image.id}
                  href={image.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded-xl bg-zinc-100 ring-1 ring-black/5 dark:bg-zinc-800 dark:ring-white/10"
                  style={{ width: carousel ? 'min(320px, 100%)' : fitWidth(image) }}
                >
                  <img
                    src={image.url}
                    alt={t('图片 {index}', { index: index + 1 })}
                    loading="lazy"
                    className="block h-auto w-full object-contain"
                    style={
                      image.width && image.height ? { aspectRatio: `${image.width} / ${image.height}` } : undefined
                    }
                  />
                </a>
              ),
          )}
        </div>
      )}
      {showTaskFrame && task?.status === 'pending' && (
        <div
          role="status"
          className="relative flex max-w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-xl bg-zinc-100 p-4 text-center ring-1 ring-black/5 dark:bg-zinc-800/60 dark:ring-white/10"
          style={frameStyle}
        >
          {/* 缓慢流动的光带，提示正在生成 */}
          <div className="pointer-events-none absolute inset-0 animate-pulse bg-gradient-to-br from-violet-500/5 via-transparent to-violet-500/10" />
          <span
            aria-hidden="true"
            className="size-7 animate-spin rounded-full border-2 border-zinc-300 border-t-violet-500 dark:border-zinc-600 dark:border-t-violet-400"
          />
          <span className="text-sm font-medium text-zinc-600 dark:text-zinc-300">{stageText}</span>
          {task.prompt && (
            <span className="line-clamp-2 max-w-full px-2 text-xs break-words text-zinc-400">
              {task.prompt.slice(0, 80)}
            </span>
          )}
          <Button size="sm" disabled={saving} onClick={() => void imageAction('cancel')}>
            {t('取消')}
          </Button>
        </div>
      )}
      {showTaskFrame && task?.status === 'error' && (
        <div
          role="alert"
          className={cx(
            'flex max-w-full flex-col items-center justify-center gap-2.5 overflow-auto rounded-xl p-4 text-center ring-1',
            cancelled
              ? 'bg-zinc-100 text-zinc-500 ring-black/5 dark:bg-zinc-800/60 dark:ring-white/10'
              : 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900',
          )}
          style={frameStyle}
        >
          <span
            aria-hidden="true"
            className={cx(
              'flex size-9 items-center justify-center rounded-full text-lg',
              cancelled ? 'bg-zinc-200 dark:bg-zinc-700' : 'bg-red-100 dark:bg-red-900/60',
            )}
          >
            {cancelled ? '⏹' : '!'}
          </span>
          <strong className="text-sm">{cancelled ? t('已取消') : t('图片生成失败')}</strong>
          {!cancelled && (
            <div className="w-full min-w-0">
              <p className={cx('text-xs break-words whitespace-pre-wrap opacity-90', !expandedError && 'line-clamp-3')}>
                {task.error || t('未知错误')}
              </p>
              {!!task.error && task.error.length > 60 && (
                <button
                  type="button"
                  className="mt-1 text-xs underline underline-offset-2 opacity-70 hover:opacity-100"
                  onClick={() => setExpandedError(!expandedError)}
                >
                  {expandedError ? t('收起') : t('详情')}
                </button>
              )}
            </div>
          )}
          {task.prompt && (
            <span className="line-clamp-2 max-w-full text-xs break-words opacity-60">{task.prompt.slice(0, 80)}</span>
          )}
          <div className="flex flex-wrap justify-center gap-1.5">
            <Button size="sm" disabled={saving} onClick={() => void imageAction('retry')}>
              {t('重新生成')}
            </Button>
            <Button size="sm" disabled={saving} onClick={() => setEditingPrompt(true)}>
              {t('改提示词…')}
            </Button>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => void imageAction('dismiss')}>
              {t('放弃')}
            </Button>
          </div>
        </div>
      )}
      {/* 一行工具栏：备选切换 + 扩展按钮（重新生成、设为背景）。桌面端悬停时才完全显示 */}
      <div className="flex min-h-8 flex-wrap items-center gap-0.5 text-xs text-zinc-500 transition-opacity [@media(hover:hover)]:opacity-50 [@media(hover:hover)]:group-hover/media:opacity-100 [@media(hover:hover)]:focus-within:opacity-100">
        {carousel && (count > 1 || canGenerateAlternative) && (
          <div className="mr-1 flex items-center rounded-lg">
            <IconButton
              label={t('上一张图片')}
              disabled={saving || imageIndex === 0}
              onClick={() => void switchImage(-1)}
            >
              <ChevronLeftIcon />
            </IconButton>
            <span className="min-w-8 text-center tabular-nums">{`${imageIndex + 1}/${count}`}</span>
            {(() => {
              const atLast = imageIndex === count - 1
              const generate = atLast && !hasTaskFrame && canGenerateAlternative
              return (
                <IconButton
                  label={generate ? t('生成备选图（保留现有图片，再生成一张）') : t('下一张图片')}
                  disabled={saving || (atLast && !generate)}
                  onClick={() => void switchImage(1)}
                >
                  <ChevronRightIcon />
                </IconButton>
              )
            })()}
          </div>
        )}
        {!showTaskFrame && images[imageIndex] && <CgToggle image={images[imageIndex]} />}
        {task && <Slot name="chat.message.media" props={{ chatId, message: msg }} />}
      </div>
      {editingPrompt && task && (
        <ImagePromptDialog
          review={{
            preview: { prompt: task.prompt ?? '', negative: task.negative ?? '' },
            resolve: (edited) => {
              setEditingPrompt(false)
              if (edited) void imageAction('retry', edited)
            },
          }}
        />
      )}
    </div>
  )
}

/** 工具调用的结果：显示成一张紧凑的小卡片 */
function ToolMessage({ msg, chatId, text }: { msg: MessageDTO; chatId: string; text: string }) {
  const label =
    msg.meta.toolName === 'roll_dice' ? t('🎲 掷骰') : t('🔧 {toolName}', { toolName: msg.meta.toolName ?? t('工具') })
  return (
    <div className="px-4 py-1 pl-[68px]">
      <div className="inline-flex max-w-full items-start gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-900">
        <span className="shrink-0 font-medium text-zinc-500">{label}</span>
        <span className="min-w-0 break-words whitespace-pre-wrap">{text}</span>
      </div>
      <MessageMedia msg={msg} chatId={chatId} />
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
  // 编辑态里的思考过程：null 表示没有展开编辑（保存时不动它）
  const [editingReasoning, setEditingReasoning] = useState<string | null>(null)
  const bookmarks = useBookmarks(chatId)
  const bookmark = bookmarks.data?.find((b) => b.messageId === msg.id && b.kind === 'bookmark')

  if (msg.role === 'tool')
    return <ToolMessage msg={msg} chatId={chatId} text={transformMessage(msg.content, msg, transforms)} />
  // 旁白 / 系统消息（/sys、/roll 等命令插入的）：居中的一行，不显示角色头像和名字
  // 带图片的系统消息（图片生成等插入的）照常按普通消息显示
  if (msg.role === 'system' && !msg.meta.images?.length && !msg.meta.imageGen)
    return <NarrationMessage msg={msg} chatId={chatId} />

  const isUser = msg.role === 'user'
  const speaker = msg.speakerId ? cast.speakers[msg.speakerId] : undefined
  const who = isUser ? cast.user : (speaker ?? { ...cast.fallback, name: msg.meta.name ?? cast.fallback.name })
  const isStreaming = liveText !== null || msg.status === 'streaming'
  // {{char}} 用这条消息的角色（用户消息里用会话的角色），{{user}} 用当前人设
  const charName = isUser ? (speaker?.name ?? cast.fallback.name) : who.name
  const raw = liveText ?? msg.content
  // 舞台指令只对角色回复生效：隐藏标签、台词速记改写成「**名字**：台词」，流式时连半截标签一起藏
  const visible =
    cast.stage && msg.role === 'assistant'
      ? toDisplayText(raw, {
          knownNames: cast.stage.knownNames,
          narratorNames: cast.stage.narratorNames,
          speaker: cast.stage.showSpeaker ? 'bold' : 'none',
          streaming: isStreaming,
        })
      : raw
  const text = transformMessage(displayMacros(visible, { char: charName, user: cast.user.name }), msg, transforms)
  const choices = cast.stage?.choices && isLast && !isStreaming ? msg.meta.stage?.choices : undefined
  const reasoning = liveReasoning || msg.meta.reasoning
  // 最后一条角色回复可以向右滑出新的回复、可以续写；其他消息只能在已有的 swipe 间切换
  const isReply = msg.role === 'assistant' && msg.parentId !== null
  // 图片生成插入的纯图片消息，「重新生成」交给图片下方的按钮（再生成一张备选图），不当作文字回复重新生成
  const canRegenerate = isLast && isReply && !(msg.meta.imageGen && !msg.content.trim())

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

  const startEdit = () => {
    setEditing(msg.content)
    setEditingReasoning(msg.meta.reasoning ? msg.meta.reasoning : null)
  }
  const stopEdit = () => {
    setEditing(null)
    setEditingReasoning(null)
  }
  const saveEdit = async () => {
    if (editing === null) return
    try {
      // 思考过程：编辑框打开着就把框里的内容存回去（清空 = 删除）；没打开就不动它
      replaceMessage(qc, chatId, await api.editMessage(msg.id, editing, editingReasoning ?? undefined))
      void refreshChatState(qc, chatId)
      stopEdit()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  // 上移 / 下移：在原位置生成一条交换了顺序的新分支，原来的顺序还能左右切换回去
  const move = async (direction: 'up' | 'down') => {
    if (editing !== null && editing !== msg.content && !confirm(t('移动会放弃这次没保存的修改，继续？'))) return
    try {
      await api.moveMessage(chatId, msg.id, direction)
      stopEdit()
      await resetChat(qc, chatId)
      toast.info(direction === 'up' ? t('已上移，原来的顺序保留为另一个分支') : t('已下移，原来的顺序保留为另一个分支'))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const setExcluded = async (excluded: boolean) => {
    try {
      for (const m of await api.excludeMessages(chatId, [msg.id], excluded)) replaceMessage(qc, chatId, m)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const toggleBookmark = async () => {
    try {
      if (bookmark) {
        await api.deleteBookmark(bookmark.id)
        toast.info(t('已移除书签'))
      } else {
        const created = await api.createBookmark(chatId, msg.id)
        toast.info(t('已加书签「{name}」', { name: created.name }))
      }
      await qc.invalidateQueries({ queryKey: keys.bookmarks(chatId) })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const remove = async () => {
    if (!confirm(t('删除这条消息？它后面的所有分支也会一起删除。'))) return
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
      toast.info(t('已创建分支会话'))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  // 纯图片消息（图片生成扩展插入的）不显示文字回复的切换，图片自己有备选切换
  const imageOnly = !!msg.meta.imageGen && !msg.content.trim()
  const showSwipes = !imageOnly && (msg.swipeCount > 1 || canRegenerate)

  return (
    <div className={cx('group flex gap-3 px-4 py-3', msg.meta.excluded && 'opacity-55')}>
      <div className="message-avatar">
        <Avatar name={who.name} url={who.avatarUrl} />
      </div>
      <div className="message-box min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-sm">
          <span className="font-semibold">{who.name}</span>
          {msg.status === 'aborted' && <span className="text-xs text-zinc-400">{t('已中止')}</span>}
          {msg.meta.excluded && (
            <span
              title={t('这条消息不会发给模型（也不进总结）')}
              className="inline-flex items-center gap-1 rounded-md bg-zinc-200/80 px-1.5 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
            >
              <EyeOffIcon className="size-3" />
              {t('不发送')}
            </span>
          )}
          {bookmark && (
            <span
              title={t('书签：{name}', { name: bookmark.name })}
              className="inline-flex max-w-32 items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
            >
              <BookmarkIcon className="size-3 shrink-0" />
              <span className="truncate">{bookmark.name}</span>
            </span>
          )}
          {msg.meta.toolCalls && msg.meta.toolCalls.length > 0 && (
            <span className="text-xs text-zinc-400">
              {t('调用了 {toolNames}', { toolNames: msg.meta.toolCalls.map((c) => c.name).join('、') })}
            </span>
          )}
          {/* 操作按钮：鼠标移上来才显示；触屏设备上一直显示 */}
          {!isStreaming && editing === null && (
            <div className="ml-auto flex items-center opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:has-[details[open]]:opacity-100">
              <IconButton label={t('编辑')} onClick={startEdit} disabled={busy}>
                <EditIcon />
              </IconButton>
              {canRegenerate && (
                <IconButton
                  label={t('重新生成')}
                  onClick={() => run({ mode: 'regenerate', targetId: msg.id })}
                  disabled={busy}
                >
                  <RefreshIcon />
                </IconButton>
              )}
              <details className="message-actions relative">
                <summary className="list-none">
                  <span className="inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800">
                    <DotsIcon />
                  </span>
                </summary>
                <div className="absolute right-0 z-20 mt-1 w-44 rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
                  {canRegenerate && (
                    <MenuItem
                      icon={<ChevronRightIcon />}
                      label={t('续写')}
                      disabled={busy}
                      onClick={() => run({ mode: 'continue', targetId: msg.id })}
                    />
                  )}
                  <MenuItem icon={<BranchIcon />} label={t('从这里开分支')} disabled={busy} onClick={branch} />
                  <MenuItem
                    icon={msg.meta.excluded ? <EyeIcon /> : <EyeOffIcon />}
                    label={msg.meta.excluded ? t('恢复发送') : t('不发给模型')}
                    onClick={() => void setExcluded(!msg.meta.excluded)}
                  />
                  <MenuItem
                    icon={<BookmarkIcon />}
                    label={bookmark ? t('移除书签') : t('加书签')}
                    onClick={() => void toggleBookmark()}
                  />
                  <MenuItem
                    icon={<ListCheckIcon />}
                    label={t('多选…')}
                    onClick={() => useChatOps.getState().startSelect(chatId, msg.id)}
                  />
                  <MenuItem
                    icon={<CopyIcon />}
                    label={t('复制文本')}
                    onClick={() => navigator.clipboard.writeText(msg.content).then(() => toast.info(t('已复制')))}
                  />
                  {msg.meta.logId && (
                    <MenuItem
                      icon={<LogIcon />}
                      label={t('查看请求')}
                      onClick={() => useUi.getState().openView('logs', msg.meta.logId)}
                    />
                  )}
                  <Slot name="chat.message.actions" props={{ chatId, message: msg }} />
                  <MenuItem icon={<TrashIcon />} label={t('删除')} danger disabled={busy} onClick={remove} />
                </div>
              </details>
            </div>
          )}
        </div>

        {reasoning && (
          <details className="group/reasoning mb-2 rounded-lg border border-zinc-200/80 bg-zinc-50 text-[13px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-1.5 select-none hover:text-zinc-700 dark:hover:text-zinc-300 [&::-webkit-details-marker]:hidden">
              <ChevronRightIcon className="size-3.5 transition-transform group-open/reasoning:rotate-90" />
              {isStreaming && !text ? t('思考中…') : t('思考过程')}
            </summary>
            <div className="border-t border-zinc-200/80 px-3 py-2 leading-relaxed whitespace-pre-wrap dark:border-zinc-800">
              {reasoning}
            </div>
          </details>
        )}

        <MessageMedia msg={msg} chatId={chatId} />
        {editing !== null ? (
          <div className="space-y-2">
            {msg.role === 'assistant' &&
              (editingReasoning !== null ? (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900/60">
                  <div className="mb-1 flex items-center text-xs text-zinc-500">
                    <span className="flex-1">{t('思考过程（清空后保存就删除）')}</span>
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-800"
                      onClick={() => setEditingReasoning('')}
                    >
                      {t('清空')}
                    </button>
                  </div>
                  <textarea
                    aria-label={t('思考过程')}
                    className={`${inputClass} min-h-20 text-[13px]`}
                    value={editingReasoning}
                    onChange={(e) => setEditingReasoning(e.target.value)}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  className="text-xs text-zinc-500 underline-offset-2 hover:text-violet-600 hover:underline"
                  onClick={() => setEditingReasoning(msg.meta.reasoning ?? '')}
                >
                  {msg.meta.reasoning ? t('编辑思考过程') : t('+ 添加思考过程')}
                </button>
              ))}
            <textarea
              aria-label={t('消息内容')}
              className={`${inputClass} min-h-32`}
              value={editing}
              onChange={(e) => setEditing(e.target.value)}
              // biome-ignore lint/a11y/noAutofocus: 点了编辑就该直接能输入
              autoFocus
            />
            <div className="flex items-center gap-2">
              <Button variant="primary" onClick={saveEdit}>
                {t('保存')}
              </Button>
              <Button onClick={stopEdit}>{t('取消')}</Button>
              {/* 上移 / 下移（和酒馆一样放在编辑态）；带工具调用的消息不能移动 */}
              {!msg.meta.toolCalls?.length && (
                <div className="ml-auto flex items-center gap-0.5">
                  <IconButton
                    label={t('上移（原顺序保留为另一个分支）')}
                    disabled={busy}
                    onClick={() => void move('up')}
                  >
                    <ArrowUpIcon />
                  </IconButton>
                  <IconButton
                    label={t('下移（原顺序保留为另一个分支）')}
                    disabled={busy}
                    onClick={() => void move('down')}
                  >
                    <ArrowDownIcon />
                  </IconButton>
                </div>
              )}
            </div>
          </div>
        ) : text || isStreaming ? (
          <div className={cx(isUser && 'text-zinc-800 dark:text-zinc-200', isStreaming && 'streaming-cursor')}>
            <FormattedText text={text} />
          </div>
        ) : null}

        {choices && choices.length > 0 && (
          <Choices options={choices} disabled={busy} onPick={(text) => void run({ mode: 'send', text, images: [] })} />
        )}

        <Slot name="chat.message.footer" props={{ chatId, message: { ...msg, content: liveText ?? msg.content } }} />

        {msg.status === 'error' && (
          <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {t('生成失败：{error}', { error: msg.meta.error ?? '' })}
          </div>
        )}

        {showSwipes && !isStreaming && (
          <div className="mt-1 flex items-center gap-1 text-xs text-zinc-500">
            <IconButton label={t('上一个回复')} onClick={() => swipe(-1)} disabled={busy || msg.swipeIndex <= 1}>
              <ChevronLeftIcon />
            </IconButton>
            <span className="tabular-nums">
              {msg.swipeIndex} / {msg.swipeCount}
            </span>
            <IconButton
              label={msg.swipeIndex === msg.swipeCount ? t('生成新回复') : t('下一个回复')}
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

/**
 * 模型给出的选项（<choices>）：最后一条回复下方的一组按钮，点一下就作为你的发言发出去。
 * 带检定的选项（[察觉 DC12]）先在右侧标出技能和难度，掷骰在 VN5 再做。
 */
function Choices({
  options,
  disabled,
  onPick,
}: {
  options: ChoiceOption[]
  disabled: boolean
  onPick: (text: string) => void
}) {
  return (
    <fieldset aria-label={t('选项')} className="mt-3 grid gap-1.5">
      {options.map((option, index) => (
        <button
          // 选项列表在消息定稿后不会再变，下标做 key 是安全的
          key={index}
          type="button"
          disabled={disabled}
          onClick={() => onPick(option.text)}
          className="group flex min-h-9 w-full items-center gap-2.5 rounded-lg border border-zinc-200 bg-white/70 px-3 py-1.5 text-left text-sm transition-colors hover:border-violet-300 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900/60 dark:hover:border-violet-700 dark:hover:bg-violet-950/50"
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-medium text-zinc-500 tabular-nums group-hover:bg-violet-100 group-hover:text-violet-700 dark:bg-zinc-800 dark:text-zinc-400 dark:group-hover:bg-violet-900 dark:group-hover:text-violet-300">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1">{option.text}</span>
          {option.check && (
            <span className="shrink-0 rounded-md bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
              {option.check.skill} DC{option.check.dc}
            </span>
          )}
        </button>
      ))}
    </fieldset>
  )
}

/** 图片工具栏上的星标：收进 / 移出这个角色的 CG 画廊 */
function CgToggle({ image }: { image: AttachmentDTO }) {
  const setCg = useSetAttachmentCg()
  return (
    <IconButton
      label={image.isCg ? t('移出 CG 画廊') : t('收进 CG 画廊')}
      disabled={setCg.isPending}
      className={image.isCg ? 'text-amber-500' : undefined}
      onClick={() =>
        setCg.mutate({ id: image.id, isCg: !image.isCg }, { onError: (e) => toast.error(errorMessage(e)) })
      }
    >
      <StarIcon filled={image.isCg} />
    </IconButton>
  )
}

/** 旁白消息：居中、无头像，悬停时右侧出现删除按钮 */
function NarrationMessage({ msg, chatId }: { msg: MessageDTO; chatId: string }) {
  const qc = useQueryClient()
  return (
    <div className="group/narration chat-column flex items-center justify-center gap-1 px-4 py-2">
      <p className="max-w-[85%] rounded-xl bg-zinc-100/80 px-3.5 py-1.5 text-center text-[13px] leading-relaxed whitespace-pre-wrap text-zinc-600 backdrop-blur dark:bg-zinc-800/70 dark:text-zinc-300">
        {msg.content}
      </p>
      <IconButton
        label={t('删除')}
        className="opacity-0 group-hover/narration:opacity-100 focus-visible:opacity-100"
        onClick={async () => {
          if (!confirm(t('删除这条消息？它后面的所有分支也会一起删除。'))) return
          try {
            await api.deleteMessage(msg.id)
            await resetChat(qc, chatId)
          } catch (e) {
            toast.error(errorMessage(e))
          }
        }}
      >
        <TrashIcon />
      </IconButton>
    </div>
  )
}
