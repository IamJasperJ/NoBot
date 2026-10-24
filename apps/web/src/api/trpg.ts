import { type CheckResult, type ChoiceOption, IMPLEMENTED_RULE_SYSTEMS } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { emitClientEvent } from '../extensions/runtime'
import { runGeneration } from '../features/chat/generate'
import { t } from '../i18n'
import { useMiniAppHaptic } from '../miniapp/telegram'
import { useFreshMessage } from '../stores/freshMessages'
import { api } from './client'
import { flattenPages, useChatPages, usePlayPresets } from './queries'
import { roomsApi, scopeForChat } from './rooms'

function usePlay(chatId: string | null) {
  const page = useChatPages(chatId).data?.pages[0]
  const presets = usePlayPresets(chatId)
  return page?.roomView?.play ?? presets.data?.find((preset) => preset.id === page?.playPresetId)?.data
}

function isEnabled(play: ReturnType<typeof usePlay>) {
  return !!play?.directives?.enabled && !!play.trpg && IMPLEMENTED_RULE_SYSTEMS.includes(play.trpg.ruleSystem)
}

/**
 * VN5 跑团的前端数据层。界面只通过这里调接口，自己不 fetch。
 */

/**
 * 点选项。选项带检定（option.check）、会话的玩法预设启用了跑团（规则系统已实现）且 trpg.choiceRollClient 为 true 时：
 *   1. 调 POST /api/chats/:id/check 掷骰，拿到 CheckResult 放进 pending（界面据此弹出检定卡片演出）
 *   2. 等 trpg.diceAnimation ? trpg.diceMs + 900 : 0 毫秒（让玩家看清结果）
 *   3. 用原来发送选项的同一条路径发送选项文本（option.text），请求体带上 check；然后清空 pending
 * 其他情况直接发送选项文本（和现在一样）。出错时清空 pending 并把错误抛给调用方。
 * 发送中（含演出等待）busy 为 true，防止重复点击。
 */
export function usePickChoice(chatId: string): {
  pick: (option: ChoiceOption) => Promise<void>
  pending: CheckResult | null
  busy: boolean
} {
  const qc = useQueryClient()
  const play = usePlay(chatId)
  const [pending, setPending] = useState<CheckResult | null>(null)
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const haptic = useMiniAppHaptic()
  return {
    pending,
    busy,
    pick: async (option) => {
      if (locked.current) return
      locked.current = true
      haptic()
      setBusy(true)
      try {
        const roomId = scopeForChat(chatId)
        if (roomId) {
          const messages = flattenPages(qc.getQueryData(['chat', chatId]))
          const source = messages.findLast((m) => m.meta.stage?.choices?.some((choice) => choice.text === option.text))
          const index = source?.meta.stage?.choices?.findIndex((choice) => choice.text === option.text)
          if (!source || index === undefined || index < 0) throw new Error(t('选项已不可用'))
          await roomsApi.vote({ id: roomId, messageId: source.id, index })
          await qc.invalidateQueries({ queryKey: ['chat', chatId] })
          return
        }
        let check: CheckResult | undefined
        if (option.check && isEnabled(play) && play?.trpg?.choiceRollClient) {
          check = await api.checkChoice(chatId, option.check)
          setPending(check)
          if (play.trpg.diceAnimation) await new Promise((resolve) => setTimeout(resolve, play.trpg.diceMs + 900))
        }
        emitClientEvent({ type: 'message:sent', chatId, text: option.text })
        await runGeneration(qc, chatId, { mode: 'send', text: option.text, images: [], ...(check ? { check } : {}) })
      } finally {
        setPending(null)
        setBusy(false)
        locked.current = false
      }
    },
  }
}

/**
 * 当前会话的跑团显示设置（来自会话生效的玩法预设 trpg 分组）和是否启用了已实现的规则系统。
 * 没有会话或没加载完时返回 enabled=false 的默认值。
 */
export function useTrpgSettings(chatId: string | null): {
  enabled: boolean
  diceAnimation: boolean
  diceMs: number
  showDc: boolean
  initiativeBar: boolean
} {
  const play = usePlay(chatId)
  return {
    enabled: !!chatId && isEnabled(play),
    diceAnimation: play?.trpg?.diceAnimation ?? true,
    diceMs: play?.trpg?.diceMs ?? 800,
    showDc: play?.trpg?.showDc ?? true,
    initiativeBar: play?.trpg?.initiativeBar ?? true,
  }
}

/**
 * 某条消息的骰子 / 检定卡片是否要播放动画：只有本次会话里「刚生成出来」的消息播放，
 * 历史消息、刷新页面后重新加载的消息直接显示结果。返回 true 后同一条消息再渲染也保持 true，直到动画时长过去。
 */
export function useFreshDice(messageId: string, ms: number): boolean {
  return useFreshMessage(messageId, ms)
}
