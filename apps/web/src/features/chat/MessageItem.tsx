import { toDisplayText } from '@nobot/core/stage'
import type { MessageDTO } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { memo, useState } from 'react'
import { api } from '../../api/client'
import { resetChat, useBookmarks } from '../../api/queries'
import {
  useMessageTranslation,
  useTranslateEnabled,
  useTranslationPending,
  useTranslationView,
} from '../../api/translation'
import { useFreshDice, usePickChoice, useTrpgSettings } from '../../api/trpg'
import { BookmarkIcon, ChevronLeftIcon, ChevronRightIcon, EyeOffIcon } from '../../components/icons'
import { Avatar, cx, IconButton } from '../../components/ui'
import { transformMessage, useExtensionsRuntime } from '../../extensions/runtime'
import { Slot } from '../../extensions/Slot'
import { t } from '../../i18n'
import { useStreaming } from '../../stores/streaming'
import { errorMessage, toast } from '../../stores/toast'
import { RoomChoiceStatus, useChoiceGate } from '../rooms/RoomChoiceStatus'
import { RoomMessageActions, SuggestionCount } from '../rooms/RoomMessageActions'
import { privacyLabel, useRoomInfo } from '../rooms/shared'
import { CheckCard } from '../trpg/DiceCard'
import { displayMacros, FormattedText } from './format'
import { runGeneration } from './generate'
import { MessageActions } from './MessageActions'
import { MessageEditor } from './MessageEditor'
import { MessageMedia } from './MessageMedia'
import { Choices, NarrationMessage, ToolMessage } from './MessageParts'

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
  /** 是否显示这条消息的选项（最后一条非纯图片消息） */
  showChoices: boolean
  /** 会话里是否有正在进行的生成（生成中禁止改动消息树） */
  busy: boolean
  cast: ChatCast
}

/**
 * 单条消息。用 memo 包起来，只有自己的数据变了才重新渲染。
 * 正在生成的那条消息额外订阅 streaming store 里的文本。
 */
export const MessageItem = memo(function MessageItem({ msg, chatId, isLast, showChoices, busy, cast }: Props) {
  const transforms = useExtensionsRuntime((s) => s.transforms)
  const qc = useQueryClient()
  const liveText = useStreaming((s) =>
    s.streams[msg.chatId]?.messageId === msg.id ? (s.streams[msg.chatId]?.text ?? null) : null,
  )
  const liveReasoning = useStreaming((s) =>
    s.streams[msg.chatId]?.messageId === msg.id ? (s.streams[msg.chatId]?.reasoning ?? null) : null,
  )
  const [editing, setEditing] = useState(false)
  const bookmarks = useBookmarks(chatId)
  const bookmark = bookmarks.data?.find((b) => b.messageId === msg.id && b.kind === 'bookmark')
  // 跑团：选项检定先掷骰再发送；翻译：正文可以在原文 / 译文间切换
  const trpg = useTrpgSettings(chatId)
  const pickChoice = usePickChoice(chatId)
  const choiceGate = useChoiceGate(chatId)
  const freshCheck = useFreshDice(msg.id, trpg.diceMs)
  const translateEnabled = useTranslateEnabled(chatId)
  const translation = useMessageTranslation(chatId, msg)
  const view = useTranslationView(msg)
  const translating = useTranslationPending(msg)
  const room = useRoomInfo(chatId)

  // 联机房间里别人的私信、看不到的骰子：服务端只给了空占位，不显示也不占位置
  if (msg.meta.hidden && !msg.content) return null
  const privacy = privacyLabel(msg.meta, room)

  if (msg.role === 'tool')
    return <ToolMessage msg={msg} chatId={chatId} text={transformMessage(msg.content, msg, transforms)} />
  // 旁白 / 系统消息（/sys、/roll 等命令插入的）：居中的一行，不显示角色头像和名字
  // 带图片的系统消息（图片生成等插入的）照常按普通消息显示
  if (msg.role === 'system' && !msg.meta.images?.length && !msg.meta.imageGen)
    return <NarrationMessage msg={msg} chatId={chatId} badge={privacy} canDelete={!room || room.myRole === 'owner'} />

  const isUser = msg.role === 'user'
  const speaker = msg.speakerId ? cast.speakers[msg.speakerId] : undefined
  const who = isUser
    ? { ...cast.user, name: msg.meta.author?.name ?? msg.meta.name ?? cast.user.name }
    : (speaker ?? { ...cast.fallback, name: msg.meta.name ?? cast.fallback.name })
  const isStreaming = liveText !== null || msg.status === 'streaming'
  // {{char}} 用这条消息的角色（用户消息里用会话的角色），{{user}} 用当前人设
  const charName = isUser ? (speaker?.name ?? cast.fallback.name) : who.name
  // 流式时只有原文；定稿后按「显示译文 / 原文」的选择取正文
  const raw = liveText ?? (view.hasTranslation ? view.text : msg.content)
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
  const choices = cast.stage?.choices && showChoices && !isStreaming ? msg.meta.stage?.choices : undefined
  const reasoning = liveReasoning || (view.hasTranslation ? view.reasoning : msg.meta.reasoning)
  // 最后一条角色回复可以向右滑出新的回复、可以续写；其他消息只能在已有的 swipe 间切换
  const isReply = msg.role === 'assistant' && msg.parentId !== null
  // 图片生成插入的纯图片消息，「重新生成」交给图片下方的按钮（再生成一张备选图），不当作文字回复重新生成
  // 联机房间：重新生成、切换候选只有房主和主持能用
  const canRegenerate =
    isLast && isReply && !(msg.meta.imageGen && !msg.content.trim()) && (!room || room.permissions.canRegenerate)
  const canSwipe = !room || room.permissions.canSwipe
  const ooc = msg.meta.channel === 'ooc'

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

  // 纯图片消息（图片生成扩展插入的）不显示文字回复的切换，图片自己有备选切换
  const imageOnly = !!msg.meta.imageGen && !msg.content.trim()
  const showSwipes = !imageOnly && canSwipe && (msg.swipeCount > 1 || canRegenerate)

  return (
    <div className={cx('group flex gap-3 px-4 py-3', msg.meta.excluded && !privacy && 'opacity-55')}>
      <div className="message-avatar">
        <Avatar name={who.name} url={who.avatarUrl} />
      </div>
      <div className="message-box min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-sm">
          <span className="font-semibold">{who.name}</span>
          {msg.status === 'aborted' && <span className="text-xs text-zinc-400">{t('已中止')}</span>}
          {privacy ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-violet-100 px-1.5 py-0.5 text-[11px] text-violet-700 dark:bg-violet-950 dark:text-violet-300">
              <EyeOffIcon className="size-3" />
              {privacy}
            </span>
          ) : ooc ? (
            <span
              title={t('场外闲聊，AI 看不到')}
              className="rounded-md bg-zinc-200/80 px-1.5 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
            >
              {t('场外')}
            </span>
          ) : (
            msg.meta.excluded && (
              <span
                title={t('这条消息不会发给模型（也不进总结）')}
                className="inline-flex items-center gap-1 rounded-md bg-zinc-200/80 px-1.5 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
              >
                <EyeOffIcon className="size-3" />
                {t('不发送')}
              </span>
            )
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
          {view.hasTranslation && !isStreaming && (
            <button
              type="button"
              onClick={view.toggle}
              title={
                view.stale
                  ? t('正文在翻译后被修改过，译文可能过期')
                  : view.showTranslation
                    ? t('点击查看原文')
                    : t('点击查看译文')
              }
              className={cx(
                'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]',
                view.stale
                  ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
                  : 'bg-sky-50 text-sky-700 hover:bg-sky-100 dark:bg-sky-950/60 dark:text-sky-300',
              )}
            >
              {msg.meta.translation?.direction === 'source'
                ? view.showTranslation
                  ? t('已翻译发送')
                  : t('发送的译文')
                : view.showTranslation
                  ? t('译文')
                  : t('原文')}
              {view.stale && ' !'}
            </button>
          )}
          {translating && <span className="text-[11px] text-sky-600 dark:text-sky-400">{t('翻译中…')}</span>}
          {msg.meta.toolCalls && msg.meta.toolCalls.length > 0 && (
            <span className="text-xs text-zinc-400">
              {t('调用了 {toolNames}', { toolNames: msg.meta.toolCalls.map((c) => c.name).join('、') })}
            </span>
          )}
          {room && isReply && isLast && <SuggestionCount room={room} messageId={msg.id} />}
          {!isStreaming && !editing && room && room.myRole !== 'owner' && (
            <RoomMessageActions
              room={room}
              msg={msg}
              isLast={isLast}
              consumed={!isLast}
              onEdit={() => setEditing(true)}
            />
          )}
          {!isStreaming && !editing && (!room || room.myRole === 'owner') && (
            <MessageActions
              msg={msg}
              chatId={chatId}
              busy={busy}
              canRegenerate={canRegenerate}
              bookmark={bookmark}
              translateEnabled={translateEnabled}
              translation={translation}
              view={view}
              onEdit={() => setEditing(true)}
              onRun={(input) => void run(input)}
            />
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
        {editing ? (
          <MessageEditor msg={msg} chatId={chatId} busy={busy} onClose={() => setEditing(false)} />
        ) : text || isStreaming ? (
          <div className={cx(isUser && 'text-zinc-800 dark:text-zinc-200', isStreaming && 'streaming-cursor')}>
            {isUser && msg.meta.check && (
              <div className="mb-1.5">
                <CheckCard
                  result={msg.meta.check}
                  animate={freshCheck && trpg.diceAnimation}
                  ms={trpg.diceMs}
                  showDc={trpg.showDc}
                  compact
                />
              </div>
            )}
            <FormattedText text={text} />
          </div>
        ) : null}

        {choices && choices.length > 0 && (
          <>
            <Choices
              options={choices}
              disabled={busy || pickChoice.busy || choiceGate.locked}
              showDc={trpg.showDc}
              onPick={(option) => void pickChoice.pick(option).catch((e: unknown) => toast.error(errorMessage(e)))}
            />
            {choiceGate.hint && <p className="mt-1 text-xs text-zinc-500">{choiceGate.hint}</p>}
            <RoomChoiceStatus chatId={chatId} messageId={msg.id} count={choices.length} />
          </>
        )}
        {/* 选项检定：发送前先在屏幕中间演出这次掷骰 */}
        {pickChoice.pending && (
          <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-black/10">
            <CheckCard result={pickChoice.pending} animate={trpg.diceAnimation} ms={trpg.diceMs} showDc={trpg.showDc} />
          </div>
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
