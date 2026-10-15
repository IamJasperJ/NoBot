import { useQueryClient } from '@tanstack/react-query'
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react'
import { ApiRequestError, api } from '../../api/client'
import { SendIcon, StopIcon } from '../../components/icons'
import { IconButton } from '../../components/ui'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { runGeneration } from './generate'

/** 输入框。Enter 发送，Shift+Enter 换行；生成中显示停止按钮 */
export function Composer({ chatId, generating }: { chatId: string; generating: boolean }) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  // 高度随内容自动增长，最多 8 行左右
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  const send = async () => {
    if (generating || !text.trim()) return
    const content = text
    setText('')
    try {
      await runGeneration(qc, chatId, { mode: 'send', text: content })
    } catch (e) {
      // 发起失败时什么都没写入，把文字还给用户
      setText(content)
      toast.error(errorMessage(e))
      if (e instanceof ApiRequestError && e.code === 'NO_API_PRESET') useUi.getState().setSettingsOpen(true)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // isComposing：中文输入法正在选字时按回车是确认候选词，不能当成发送
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div className="border-t border-zinc-200 bg-white/80 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-zinc-300 bg-white px-3 py-2 focus-within:border-violet-500 dark:border-zinc-700 dark:bg-zinc-900">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="说点什么…（Shift+Enter 换行）"
          className="max-h-[200px] flex-1 resize-none bg-transparent py-1 text-[15px] outline-none placeholder:text-zinc-400"
        />
        {generating ? (
          <IconButton
            label="停止生成"
            onClick={() => api.abort(chatId).catch((e) => toast.error(errorMessage(e)))}
            className="bg-zinc-200 dark:bg-zinc-800"
          >
            <StopIcon />
          </IconButton>
        ) : (
          <IconButton
            label="发送"
            onClick={send}
            className="bg-violet-600 text-white hover:bg-violet-500 hover:text-white dark:text-white"
          >
            <SendIcon />
          </IconButton>
        )}
      </div>
    </div>
  )
}
