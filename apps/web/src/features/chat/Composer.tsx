import type { GroupDTO, MessageDTO } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react'
import { ApiRequestError, api } from '../../api/client'
import { PlusIcon, SendIcon, StopIcon } from '../../components/icons'
import { cx, IconButton } from '../../components/ui'
import { emitClientEvent } from '../../extensions/runtime'
import { Slot } from '../../extensions/Slot'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { runGeneration, runImpersonate } from './generate'

/**
 * 输入框。Enter 发送，Shift+Enter 换行；输入框为空时按 Enter 让角色接着说。
 * 左边的「+」菜单：让角色接着说、群聊里点名某个角色发言、续写最后一条、代写。
 */
export function Composer({
  chatId,
  generating,
  group,
  lastMessage,
}: {
  chatId: string
  generating: boolean
  group: GroupDTO | null
  lastMessage: MessageDTO | null
}) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [stopImpersonate, setStopImpersonate] = useState<(() => void) | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDetailsElement>(null)
  const busy = generating || stopImpersonate !== null

  // 高度随内容自动增长，最多 8 行左右
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // 空内容直接用默认的一行高度：初次渲染时布局还没稳定，scrollHeight 可能量出很大的值
    if (!text) {
      el.style.height = ''
      return
    }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  const fail = (e: unknown) => {
    toast.error(errorMessage(e))
    if (e instanceof ApiRequestError && e.code === 'NO_API_PRESET') useUi.getState().openView('connections')
  }

  const send = async () => {
    if (busy) return
    const content = text
    // 输入框为空：不发用户消息，直接让角色接着说
    if (!content.trim()) return trigger()
    emitClientEvent({ type: 'message:sent', chatId, text: content })
    setText('')
    try {
      await runGeneration(qc, chatId, { mode: 'send', text: content })
    } catch (e) {
      // 发起失败时什么都没写入，把文字还给用户
      setText(content)
      fail(e)
    }
  }

  const closeMenu = () => menuRef.current?.removeAttribute('open')

  const trigger = (speakerId?: string) => {
    closeMenu()
    runGeneration(qc, chatId, { mode: 'trigger', ...(speakerId ? { speakerId } : {}) }).catch(fail)
  }

  const continueLast = () => {
    closeMenu()
    if (lastMessage) runGeneration(qc, chatId, { mode: 'continue', targetId: lastMessage.id }).catch(fail)
  }

  const impersonate = () => {
    closeMenu()
    setText('')
    const stop = runImpersonate(chatId, {
      onText: (t) => setText((s) => s + t),
      onError: (m) => toast.error(m),
      onDone: () => setStopImpersonate(null),
    })
    setStopImpersonate(() => stop)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // isComposing：中文输入法正在选字时按回车是确认候选词，不能当成发送
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  const canContinue = lastMessage?.role === 'assistant' && lastMessage.parentId !== null

  return (
    <div className="border-t border-zinc-200 bg-white/80 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-zinc-300 bg-white px-2 py-2 focus-within:border-violet-500 dark:border-zinc-700 dark:bg-zinc-900">
        <details ref={menuRef} className="relative">
          <summary className={cx('list-none', busy && 'pointer-events-none opacity-40')}>
            <span className="inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800">
              <PlusIcon />
            </span>
          </summary>
          <div className="absolute bottom-10 left-0 z-20 w-52 rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
            <MenuButton onClick={() => trigger()} label={group ? '按发言顺序让角色接着说' : '让角色接着说'} />
            {group && (
              <>
                <div className="px-3 pt-2 pb-1 text-xs text-zinc-400">点名发言</div>
                {group.members.map((m) => (
                  <MenuButton key={m.characterId} onClick={() => trigger(m.characterId)} label={`让 ${m.name} 说`} />
                ))}
                <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
              </>
            )}
            <MenuButton onClick={continueLast} label="续写最后一条回复" disabled={!canContinue} />
            <MenuButton onClick={impersonate} label="代写（AI 替我写一条）" />
            <Slot name="chat.composer.menu" props={{ chatId, setText, close: closeMenu }} />
          </div>
        </details>
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={stopImpersonate ? '代写中…' : '说点什么…（Shift+Enter 换行）'}
          className="max-h-[200px] flex-1 resize-none bg-transparent py-1 text-[15px] outline-none placeholder:text-zinc-400"
        />
        {busy ? (
          <IconButton
            label="停止"
            onClick={() =>
              stopImpersonate ? stopImpersonate() : api.abort(chatId).catch((e) => toast.error(errorMessage(e)))
            }
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

function MenuButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="block w-full px-3 py-1.5 text-left hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800"
    >
      {label}
    </button>
  )
}
