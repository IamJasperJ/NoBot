import type { ChoiceOption, MessageDTO } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { resetChat } from '../../api/queries'
import { useFreshDice, useTrpgSettings } from '../../api/trpg'
import { TrashIcon } from '../../components/icons'
import { cx, IconButton } from '../../components/ui'
import { Slot } from '../../extensions/Slot'
import { t } from '../../i18n'
import { errorMessage, toast } from '../../stores/toast'
import { CheckCard, DiceCard } from '../trpg/DiceCard'
import { checkSkillLabel } from '../trpg/labels'
import { MessageMedia } from './MessageMedia'

/** 删除一条消息（连同后面的分支），确认后刷新消息树 */
export async function deleteMessage(qc: ReturnType<typeof useQueryClient>, chatId: string, messageId: string) {
  if (!confirm(t('删除这条消息？它后面的所有分支也会一起删除。'))) return
  try {
    await api.deleteMessage(messageId)
    await resetChat(qc, chatId)
  } catch (e) {
    toast.error(errorMessage(e))
  }
}

/** 工具调用的结果：显示成一张紧凑的小卡片 */
export function ToolMessage({ msg, chatId, text }: { msg: MessageDTO; chatId: string; text: string }) {
  const trpg = useTrpgSettings(chatId)
  const fresh = useFreshDice(msg.id, trpg.diceMs)
  const animate = fresh && trpg.diceAnimation
  const label =
    msg.meta.toolName === 'roll_dice'
      ? t('🎲 掷骰')
      : msg.meta.toolName === 'ability_check'
        ? t('🎲 检定')
        : t('🔧 {toolName}', { toolName: msg.meta.toolName ?? t('工具') })
  return (
    <div className="px-4 py-1 pl-[68px]">
      <div className="inline-flex max-w-full items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm dark:border-zinc-800 dark:bg-zinc-900">
        <span className="shrink-0 font-medium text-zinc-500">{label}</span>
        {/* 结构化的掷骰 / 检定结果画成骰子，旧消息或其他工具仍显示文字 */}
        {msg.meta.check ? (
          <CheckCard result={msg.meta.check} animate={animate} ms={trpg.diceMs} showDc={trpg.showDc} compact />
        ) : msg.meta.dice ? (
          <DiceCard result={msg.meta.dice} animate={animate} ms={trpg.diceMs} compact />
        ) : (
          <span className="min-w-0 break-words whitespace-pre-wrap">{text}</span>
        )}
      </div>
      <MessageMedia msg={msg} chatId={chatId} />
      <Slot name="chat.message.footer" props={{ chatId, message: msg }} />
    </div>
  )
}

/** 旁白消息：居中、无头像，悬停时右侧出现删除按钮 */
export function NarrationMessage({
  msg,
  chatId,
  badge,
  canDelete = true,
}: {
  msg: MessageDTO
  chatId: string
  /** 联机房间里非公开骰子的标记（主持可见 / 暗骰 / 仅自己可见） */
  badge?: string | null
  canDelete?: boolean
}) {
  const qc = useQueryClient()
  return (
    <div className="group/narration chat-column flex items-center justify-center gap-1 px-4 py-2">
      <p className="max-w-[85%] rounded-xl bg-zinc-100/80 px-3.5 py-1.5 text-center text-[13px] leading-relaxed whitespace-pre-wrap text-zinc-600 backdrop-blur dark:bg-zinc-800/70 dark:text-zinc-300">
        {badge && (
          <span className="mr-1.5 inline-flex rounded-md bg-violet-100 px-1.5 py-0.5 align-[1px] text-[11px] text-violet-700 dark:bg-violet-950 dark:text-violet-300">
            {badge}
          </span>
        )}
        {msg.content}
      </p>
      {canDelete && (
        <IconButton
          label={t('删除')}
          className="opacity-0 group-hover/narration:opacity-100 focus-visible:opacity-100"
          onClick={() => void deleteMessage(qc, chatId, msg.id)}
        >
          <TrashIcon />
        </IconButton>
      )}
    </div>
  )
}

/** 消息「⋯」菜单里的一项，点完自动收起菜单 */
export function MenuItem({
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
 * 带检定的选项（[察觉 DC12] / [Perception DC 12]）在右侧标出技能和难度；点了之后先掷骰再发送（usePickChoice）。
 */
export function Choices({
  options,
  disabled,
  showDc,
  onPick,
}: {
  options: ChoiceOption[]
  disabled: boolean
  showDc: boolean
  onPick: (option: ChoiceOption) => void
}) {
  return (
    <fieldset aria-label={t('选项')} className="mt-3 grid gap-1.5">
      {options.map((option, index) => (
        <button
          // 选项列表在消息定稿后不会再变，下标做 key 是安全的
          key={index}
          type="button"
          disabled={disabled}
          onClick={() => onPick(option)}
          className="group flex min-h-9 w-full items-center gap-2.5 rounded-lg border border-zinc-200 bg-white/70 px-3 py-1.5 text-left text-sm transition-colors hover:border-violet-300 hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900/60 dark:hover:border-violet-700 dark:hover:bg-violet-950/50"
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-medium text-zinc-500 tabular-nums group-hover:bg-violet-100 group-hover:text-violet-700 dark:bg-zinc-800 dark:text-zinc-400 dark:group-hover:bg-violet-900 dark:group-hover:text-violet-300">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1">{option.text}</span>
          {option.check && (
            <span className="shrink-0 rounded-md bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">
              {checkSkillLabel(option.check.skill)}
              {showDc && ` DC${option.check.dc}`}
            </span>
          )}
        </button>
      ))}
    </fieldset>
  )
}
