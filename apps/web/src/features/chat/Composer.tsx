import type { AttachmentDTO, GroupDTO, MessageDTO } from '@ai-parter/shared'
import { useQueryClient } from '@tanstack/react-query'
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react'
import { ApiRequestError, api } from '../../api/client'
import { useChatPages, usePlayPresets } from '../../api/queries'
import { PlusIcon, SendIcon, StopIcon } from '../../components/icons'
import { IconButton } from '../../components/ui'
import { emitClientEvent } from '../../extensions/runtime'
import { Slot } from '../../extensions/Slot'
import { useMobile } from '../../hooks/useMobile'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { useVn, useVnMode } from '../../stores/vn'
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
  const mobile = useMobile()
  const qc = useQueryClient()
  // VN 视图切换：玩法预设开了舞台指令时才显示这一项
  const page = useChatPages(chatId).data?.pages[0]
  const play = usePlayPresets().data?.find((p) => p.id === page?.playPresetId)?.data
  const inVn = useVnMode(chatId, !!play?.basic.openInVn)
  const setVnMode = useVn((s) => s.setMode)
  const [text, setText] = useState('')
  const [images, setImages] = useState<{ key: string; attachment?: AttachmentDTO }[]>([])
  const imagesRef = useRef(images)
  const fileRef = useRef<HTMLInputElement>(null)
  const [sending, setSending] = useState(false)
  const updateImages = (next: typeof images) => {
    imagesRef.current = next
    setImages(next)
  }
  const addImages = (files: File[]) => {
    if (busy || sending) return
    const available = 10 - imagesRef.current.length
    if (files.length > available) toast.info('每次最多附加 10 张图片')
    for (const file of files.slice(0, available)) {
      const key = crypto.randomUUID()
      updateImages([...imagesRef.current, { key }])
      void api
        .uploadAttachment(file)
        .then((attachment) => {
          updateImages(imagesRef.current.map((item) => (item.key === key ? { key, attachment } : item)))
        })
        .catch((error: unknown) => {
          updateImages(imagesRef.current.filter((item) => item.key !== key))
          toast.error(errorMessage(error))
        })
    }
  }
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
    if (busy || sending || images.some((image) => !image.attachment)) return
    const content = text
    // 输入框为空：不发用户消息，直接让角色接着说
    if (!content.trim() && !images.length) return trigger()
    emitClientEvent({ type: 'message:sent', chatId, text: content })
    const sentImages = images
    setSending(true)
    setText('')
    try {
      await runGeneration(qc, chatId, {
        mode: 'send',
        text: content,
        images: sentImages.flatMap((item) => (item.attachment ? [item.attachment.id] : [])),
      })
      updateImages([])
    } catch (e) {
      // 发起失败时什么都没写入，把文字还给用户
      setText(content)
      updateImages(sentImages)
      fail(e)
    } finally {
      setSending(false)
    }
  }

  /** 打开（或再次点击时关闭）左侧面板里的会话设置 / Prompt 预览 */
  const togglePanel = (which: 'settings' | 'preview') => {
    const ui = useUi.getState()
    const showing = ui.panelOpen && ui.view === 'chat' && (which === 'settings' ? ui.chatSettingsOpen : ui.previewOpen)
    ui.setChatSettingsOpen(which === 'settings' && !showing)
    ui.setPreviewOpen(which === 'preview' && !showing)
    if (!showing) ui.openView('chat')
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
    <div className="composer-bar border-t border-zinc-200 bg-white/80 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
      {images.length > 0 && (
        <div className="chat-column mb-2 flex gap-2 overflow-x-auto">
          {images.map((item, index) => (
            <div key={item.key} className="relative shrink-0 rounded-lg border border-zinc-300 p-1">
              {item.attachment ? (
                <img
                  src={item.attachment.url}
                  alt={`待发送图片 ${index + 1}`}
                  className="h-20 max-w-32 rounded object-contain"
                />
              ) : (
                <span role="status" className="block p-4 text-sm">
                  上传中…
                </span>
              )}
              <button
                type="button"
                aria-label={`移除图片 ${index + 1}`}
                onClick={() => updateImages(imagesRef.current.filter((image) => image.key !== item.key))}
                className="absolute top-0 right-0 rounded bg-zinc-900 px-1 text-white"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-box chat-column flex items-end gap-2 rounded-2xl border border-zinc-300 bg-white px-2 py-2 focus-within:border-violet-500 dark:border-zinc-700 dark:bg-zinc-900">
        <details ref={menuRef} className="relative shrink-0">
          <summary className="list-none">
            <span className="inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800">
              <PlusIcon />
            </span>
          </summary>
          <div className="absolute bottom-10 left-0 z-20 w-52 rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
            <MenuButton
              onClick={() => {
                closeMenu()
                fileRef.current?.click()
              }}
              label={images.length >= 10 ? '附加图片（最多 10 张）' : '附加图片'}
              disabled={sending || images.length >= 10}
            />
            <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
            <MenuButton
              onClick={() => trigger()}
              label={group ? '按发言顺序让角色接着说' : '让角色接着说'}
              disabled={busy}
            />
            {group && (
              <>
                <div className="px-3 pt-2 pb-1 text-xs text-zinc-400">点名发言</div>
                {group.members.map((m) => (
                  <MenuButton
                    key={m.characterId}
                    onClick={() => trigger(m.characterId)}
                    label={`让 ${m.name} 说`}
                    disabled={busy}
                  />
                ))}
                <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
              </>
            )}
            <MenuButton onClick={continueLast} label="续写最后一条回复" disabled={busy || !canContinue} />
            <MenuButton onClick={impersonate} label="代写（AI 替我写一条）" disabled={busy} />
            <Slot name="chat.composer.menu" props={{ chatId, setText, close: closeMenu }} />
            {/* 原来顶部标题栏里的按钮：会话设置、Prompt 预览、扩展加的按钮 */}
            <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
            {play?.directives.enabled && (
              <MenuButton
                onClick={() => {
                  closeMenu()
                  setVnMode(chatId, inVn ? 'chat' : 'vn')
                }}
                label={inVn ? '切到聊天视图' : '切到 VN 视图'}
              />
            )}
            <MenuButton
              onClick={() => {
                closeMenu()
                togglePanel('settings')
              }}
              label="会话设置"
            />
            <MenuButton
              onClick={() => {
                closeMenu()
                togglePanel('preview')
              }}
              label="Prompt 预览"
            />
            <div className="flex flex-wrap gap-1 px-2 empty:hidden">
              <Slot name="chat.header.actions" props={{ chatId }} />
            </div>
          </div>
        </details>
        <Slot name="chat.composer.buttons" props={{ chatId }} />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            addImages(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.items)
              .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
              .flatMap((item) => {
                const file = item.getAsFile()
                return file ? [file] : []
              })
            if (files.length) {
              event.preventDefault()
              addImages(files)
            }
          }}
          placeholder={stopImpersonate ? '代写中…' : mobile ? '说点什么…' : '说点什么…（Shift+Enter 换行）'}
          className="max-h-[200px] min-w-0 flex-1 resize-none bg-transparent py-1 text-[15px] outline-none placeholder:text-zinc-400"
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
            disabled={sending || images.some((item) => !item.attachment)}
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
