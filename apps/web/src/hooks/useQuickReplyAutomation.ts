import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { registerBuiltins } from '../commands/builtins'
import { activeQuickReplySets, createCommandContext } from '../commands/context'
import { onCommandEvent } from '../commands/events'
import { loadExtensions } from '../extensions/runtime'
import { waitForGenerationIdle } from '../features/chat/generate'
import { useQuickReplySets } from '../quick-replies/hooks'
import { type AutomationEvent, loreAutomationIds, runQuickReplyAutomation } from '../quick-replies/logic'
import { errorMessage, toast } from '../stores/toast'
import { useUi } from '../stores/ui'

let startup = false
let lastChatId: string | null | undefined
// 所有触发串行执行，保证同一会话的命令不会争抢生成流。
let queue = Promise.resolve()
export function useQuickReplyAutomation() {
  const qc = useQueryClient()
  const chatId = useUi((s) => s.chatId)
  const ready = useQuickReplySets().isSuccess
  useEffect(() => {
    registerBuiltins()
    const enqueue = (id: string | null, event: AutomationEvent, ids: string[] = [], depth = 0) => {
      if (depth >= 1) return
      queue = queue
        .then(async () => {
          await loadExtensions(qc)
          const sets = await activeQuickReplySets(id)
          if (id) await waitForGenerationIdle(id)
          await runQuickReplyAutomation(sets, event, createCommandContext(qc, id, depth + 1), ids, depth)
        })
        .catch((e: unknown) => {
          toast.error(errorMessage(e))
        })
    }
    const unsubscribe = onCommandEvent((e) => {
      if (e.type === 'onAi') {
        enqueue(e.chatId, 'onAi', loreAutomationIds(e.messages), e.depth)
      } else enqueue(e.chatId, e.type, [], e.depth)
    })
    return unsubscribe
  }, [qc])
  useEffect(() => {
    if (!ready) return
    const events: AutomationEvent[] = []
    if (!startup) {
      startup = true
      events.push('onStartup')
    }
    if (chatId && chatId !== lastChatId) events.push('onChatChange')
    lastChatId = chatId
    for (const event of events) {
      queue = queue
        .then(async () => {
          await loadExtensions(qc)
          const sets = await activeQuickReplySets(chatId)
          if (chatId) await waitForGenerationIdle(chatId)
          await runQuickReplyAutomation(sets, event, createCommandContext(qc, chatId, 1))
        })
        .catch((e: unknown) => {
          toast.error(errorMessage(e))
        })
    }
  }, [chatId, ready, qc])
}
