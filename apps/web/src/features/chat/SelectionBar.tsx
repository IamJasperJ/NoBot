import type { MessageDTO } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../api/client'
import { replaceMessage } from '../../api/queries'
import { EyeIcon, EyeOffIcon, XIcon } from '../../components/icons'
import { Button, IconButton } from '../../components/ui'
import { useChatOps } from '../../stores/chatOps'
import { errorMessage, toast } from '../../stores/toast'

/**
 * 多选模式的操作条（代替输入框）：选中的消息一起「不发给模型 / 恢复发送」。
 * 不提供批量删除：树上删除一个节点会连带删掉它后面的整条分支，批量删除很容易误删
 */
export function SelectionBar({ chatId, messages }: { chatId: string; messages: MessageDTO[] }) {
  const qc = useQueryClient()
  const selected = useChatOps((s) => s.selected)
  const setSelected = useChatOps((s) => s.setSelected)
  const stop = useChatOps((s) => s.stopSelect)
  const [busy, setBusy] = useState(false)
  const ids = selected.filter((id) => messages.some((m) => m.id === id))
  const allSelected = messages.length > 0 && ids.length === messages.length

  const apply = async (excluded: boolean) => {
    if (!ids.length || busy) return
    setBusy(true)
    try {
      const changed = await api.excludeMessages(chatId, ids, excluded)
      for (const m of changed) replaceMessage(qc, chatId, m)
      // 后端会自动带上配对的工具调用，数量可能比选中的多
      toast.info(`${excluded ? '已设为不发给模型' : '已恢复发送'}：${changed.length} 条`)
      stop()
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="chat-column w-full px-3 pb-3 md:px-4">
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-violet-200 bg-violet-50/95 px-3 py-2 text-sm shadow-sm backdrop-blur dark:border-violet-900 dark:bg-violet-950/80">
        <span className="font-medium text-violet-800 dark:text-violet-200">已选 {ids.length} 条</span>
        <span className="hidden text-xs text-violet-700/70 sm:inline dark:text-violet-300/70">
          点消息选中，按住 Shift 选一段
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setSelected(allSelected ? [] : messages.map((m) => m.id))}
          disabled={busy}
        >
          {allSelected ? '全不选' : '全选已加载的'}
        </Button>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" disabled={busy || !ids.length} onClick={() => void apply(true)}>
            <EyeOffIcon />
            不发给模型
          </Button>
          <Button size="sm" disabled={busy || !ids.length} onClick={() => void apply(false)}>
            <EyeIcon />
            恢复发送
          </Button>
          <IconButton label="退出多选" onClick={stop}>
            <XIcon />
          </IconButton>
        </div>
      </div>
    </div>
  )
}
