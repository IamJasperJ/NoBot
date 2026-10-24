import type { AttachmentDTO, GroupDTO, MessageDTO } from '@nobot/shared'
import { useQueryClient } from '@tanstack/react-query'
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ApiRequestError, api } from '../../api/client'
import { useChatPages, useExtensions, usePlayPresets } from '../../api/queries'
import { isRoomGuest } from '../../api/room-scope'
import { clientMessageId, reportRoomTyping, useSendRoomMessage, useSendWhisper } from '../../api/rooms'
import { useTranslateEnabled, useTranslateText } from '../../api/translation'
import { MicIcon, PlusIcon, SendIcon, StopIcon, TranslateIcon } from '../../components/icons'
import { cx, IconButton } from '../../components/ui'
import { emitClientEvent } from '../../extensions/runtime'
import { Slot } from '../../extensions/Slot'
import { useCommandInput } from '../../hooks/useCommandInput'
import { useMobile } from '../../hooks/useMobile'
import { useVoiceRecorder } from '../../hooks/useVoiceRecorder'
import { t } from '../../i18n'
import { useChatOps } from '../../stores/chatOps'
import { useCommandDrafts } from '../../stores/commandInput'
import { errorMessage, toast } from '../../stores/toast'
import { useUi } from '../../stores/ui'
import { useVn, useVnMode } from '../../stores/vn'
import { useRoomDialogs, useRoomInfo } from '../rooms/shared'
import { CommandHints } from './CommandHints'
import { runGeneration, runImpersonate } from './generate'
import { QuickReplyBar } from './QuickReplyBar'

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
  const translateEnabled = useTranslateEnabled(chatId)
  const translator = useTranslateText()
  const qc = useQueryClient()
  // VN 视图切换：玩法预设开了舞台指令时才显示这一项
  const page = useChatPages(chatId).data?.pages[0]
  // 联机房间：访客看不到房主的玩法预设，用房间视图里带的那份
  const room = useRoomInfo(chatId)
  const owner = !room || room.myRole === 'owner'
  const perms = room?.permissions
  // 发言频道：剧情 / 场外 / 私信（w:gm 发给房主和主持，w:<userId> 主持私信某个玩家）
  const [channel, setChannel] = useState<'ic' | 'ooc' | `w:${string}`>('ic')
  const sendRoom = useSendRoomMessage()
  const sendWhisper = useSendWhisper()
  const whisperTo = channel.startsWith('w:') ? channel.slice(2) : null
  // 先攻模式下没轮到自己时，剧情发言会被拒绝，提前在输入框里提示
  const turnEntry = room?.turnMode === 'initiative' ? room.initiative.order[room.initiative.current] : undefined
  const notMyTurn =
    channel === 'ic' &&
    !!room &&
    room.turnMode === 'initiative' &&
    !(turnEntry?.kind === 'member' && turnEntry.id === room.myUserId)
  const playPresets = usePlayPresets(chatId)
  const play = page?.roomView?.play ?? playPresets.data?.find((p) => p.id === page?.playPresetId)?.data
  const inVn = useVnMode(chatId, !!play?.basic.openInVn)
  const setVnMode = useVn((s) => s.setMode)
  const text = useCommandDrafts((s) => s.drafts[chatId] ?? '')
  const setText = (value: string | ((previous: string) => string)) =>
    useCommandDrafts
      .getState()
      .set(chatId, typeof value === 'function' ? value(useCommandDrafts.getState().drafts[chatId] ?? '') : value)
  const commandInput = useCommandInput(text)
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
    if (files.length > available) toast.info(t('每次最多附加 10 张图片'))
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
  // 房间里 AI 回复时大家照样可以发言（归到下一轮），只有代写时锁住输入
  const busy = room ? stopImpersonate !== null : generating || stopImpersonate !== null
  const aiBusy = generating || stopImpersonate !== null
  const canTrigger = !room || !!perms?.canTrigger

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
    if (commandInput.isCommand) {
      setSending(true)
      try {
        await commandInput.execute(text)
        if (useCommandDrafts.getState().drafts[chatId] === text) setText('')
      } catch (e) {
        fail(e)
      } finally {
        setSending(false)
      }
      return
    }
    const content = text
    // 输入框为空：不发用户消息，直接让角色接着说
    if (!content.trim() && !images.length) return canTrigger && !aiBusy ? trigger() : undefined
    if (room) {
      const sentImages = images
      setSending(true)
      setText('')
      try {
        if (whisperTo)
          await sendWhisper.mutateAsync({
            id: room.id,
            input: { text: content, to: whisperTo, clientMessageId: clientMessageId() },
          })
        else
          await sendRoom.mutateAsync({
            id: room.id,
            input: {
              text: content,
              channel: channel === 'ooc' ? 'ooc' : 'ic',
              clientMessageId: clientMessageId(),
              images: sentImages.flatMap((item) => (item.attachment ? [item.attachment.id] : [])),
            },
          })
        updateImages([])
      } catch (e) {
        setText(content)
        updateImages(sentImages)
        fail(e)
      } finally {
        setSending(false)
      }
      return
    }
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
    // Tab：补全第一个候选命令
    if (e.key === 'Tab' && commandInput.typing && commandInput.suggestions[0]) {
      e.preventDefault()
      setText(commandInput.complete(commandInput.suggestions[0].name))
      return
    }
    // isComposing：中文输入法正在选字时按回车是确认候选词，不能当成发送
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  const canContinue = lastMessage?.role === 'assistant' && lastMessage.parentId !== null

  return (
    <div className="composer-bar border-t border-zinc-200 bg-white/80 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
      {!commandInput.isCommand && <QuickReplyBar chatId={chatId} disabled={busy || sending} />}
      {commandInput.isCommand && (
        <CommandHints
          typing={commandInput.typing}
          suggestions={commandInput.suggestions}
          command={commandInput.command}
          activeArg={commandInput.activeArg}
          error={commandInput.error}
          onPick={(name) => {
            setText(commandInput.complete(name))
            ref.current?.focus()
          }}
        />
      )}
      {images.length > 0 && (
        <div className="chat-column mb-2 flex gap-2 overflow-x-auto">
          {images.map((item, index) => (
            <div key={item.key} className="relative shrink-0 rounded-lg border border-zinc-300 p-1">
              {item.attachment ? (
                <img
                  src={item.attachment.url}
                  alt={t('待发送图片 {index}', { index: index + 1 })}
                  className="h-20 max-w-32 rounded object-contain"
                />
              ) : (
                <span role="status" className="block p-4 text-sm">
                  {t('上传中…')}
                </span>
              )}
              <button
                type="button"
                aria-label={t('移除图片 {index}', { index: index + 1 })}
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
              label={images.length >= 10 ? t('附加图片（最多 10 张）') : t('附加图片')}
              disabled={sending || images.length >= 10}
            />
            <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
            {canTrigger && (
              <MenuButton
                onClick={() => trigger()}
                label={group ? t('按发言顺序让角色接着说') : t('让角色接着说')}
                disabled={aiBusy}
              />
            )}
            {group && canTrigger && (
              <>
                <div className="px-3 pt-2 pb-1 text-xs text-zinc-400">{t('点名发言')}</div>
                {group.members.map((m) => (
                  <MenuButton
                    key={m.characterId}
                    onClick={() => trigger(m.characterId)}
                    label={t('让 {name} 说', { name: m.name })}
                    disabled={aiBusy}
                  />
                ))}
                <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
              </>
            )}
            {(!room || perms?.canContinue) && (
              <MenuButton onClick={continueLast} label={t('续写最后一条回复')} disabled={aiBusy || !canContinue} />
            )}
            {owner && <MenuButton onClick={impersonate} label={t('代写（AI 替我写一条）')} disabled={aiBusy} />}
            {owner && (
              <MenuButton
                onClick={() => {
                  closeMenu()
                  useChatOps.getState().startSelect(chatId)
                }}
                label={t('选择消息（批量不发给模型）')}
              />
            )}
            {owner && play?.directives.enabled && (
              <MenuButton
                onClick={() => {
                  closeMenu()
                  useChatOps.getState().setOutfitPicker(chatId)
                }}
                label={t('切换立绘套装')}
              />
            )}
            {/* VN 视图里有自己的「调整立绘」按钮；这里是聊天视图的侧边立绘 */}
            {owner &&
              play?.directives.enabled &&
              !inVn &&
              play.sprites.sideSprite !== 'off' &&
              play.stage.draggable && (
                <MenuButton
                  onClick={() => {
                    closeMenu()
                    useChatOps.getState().setSideAdjusting(chatId)
                  }}
                  label={t('调整侧边立绘（拖动、缩放）')}
                />
              )}
            {owner && <Slot name="chat.composer.menu" props={{ chatId, setText, close: closeMenu }} />}
            {/* 原来顶部标题栏里的按钮：会话设置、Prompt 预览、扩展加的按钮 */}
            <div className="my-1 border-t border-zinc-100 dark:border-zinc-800" />
            {play?.directives.enabled && (
              <MenuButton
                onClick={() => {
                  closeMenu()
                  setVnMode(chatId, inVn ? 'chat' : 'vn')
                }}
                label={inVn ? t('切到聊天视图') : t('切到 VN 视图')}
              />
            )}
            <MenuButton
              onClick={() => {
                closeMenu()
                if (room) useRoomDialogs.getState().openManage(room.id)
                else useRoomDialogs.getState().openCreate(chatId)
              }}
              label={room ? t('房间成员与邀请') : t('开启联机…')}
            />
            {owner && (
              <>
                <MenuButton
                  onClick={() => {
                    closeMenu()
                    togglePanel('settings')
                  }}
                  label={t('会话设置')}
                />
                <MenuButton
                  onClick={() => {
                    closeMenu()
                    togglePanel('preview')
                  }}
                  label={t('Prompt 预览')}
                />
                <div className="flex flex-wrap gap-1 px-2 empty:hidden">
                  <Slot name="chat.header.actions" props={{ chatId }} />
                </div>
              </>
            )}
          </div>
        </details>
        {owner && <Slot name="chat.composer.buttons" props={{ chatId }} />}
        {room && (
          // 剧情：AI 会看到；场外：闲聊，不发给 AI；私信：只有对方看得到，也不发给 AI
          <select
            aria-label={t('发言频道')}
            value={channel}
            onChange={(e) => setChannel(e.target.value as typeof channel)}
            className={cx(
              'mb-0.5 h-7 max-w-28 shrink-0 cursor-pointer appearance-none truncate rounded-md px-2 text-xs font-semibold',
              channel === 'ic'
                ? 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300'
                : whisperTo
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                  : 'bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200',
            )}
          >
            <option value="ic">{t('剧情')}</option>
            <option value="ooc">{t('场外')}</option>
            {room.permissions.canWhisper &&
              (room.myRole === 'player' ? (
                <option value="w:gm">{t('私信主持')}</option>
              ) : (
                room.members
                  .filter((m) => m.state === 'active' && m.userId !== room.myUserId)
                  .map((m) => (
                    <option key={m.userId} value={`w:${m.userId}`}>
                      {t('私信 {name}', { name: m.personaName })}
                    </option>
                  ))
              ))}
          </select>
        )}
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
          onChange={(e) => {
            setText(e.target.value)
            if (room && e.target.value) reportRoomTyping(room.id)
          }}
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
          placeholder={
            stopImpersonate
              ? t('代写中…')
              : room && channel === 'ooc'
                ? t('场外闲聊，AI 看不到…')
                : whisperTo
                  ? t('私信，只有对方看得到…')
                  : notMyTurn
                    ? t('还没轮到你，可以发场外或私信')
                    : mobile
                      ? t('说点什么…')
                      : t('说点什么…（Shift+Enter 换行）')
          }
          className="max-h-[200px] min-w-0 flex-1 resize-none bg-transparent py-1 text-[15px] outline-none placeholder:text-zinc-400"
        />
        {/* 翻译扩展开着时：把输入框里的文字翻成模型语言再发（命令不翻） */}
        {translateEnabled && !busy && text.trim() && !commandInput.isCommand && (
          <IconButton
            label={translator.busy ? t('翻译中…') : t('翻译输入的文字')}
            disabled={translator.busy}
            onClick={() =>
              void translator
                .translate(text)
                .then((translated) => setText(translated))
                .catch((e: unknown) => toast.error(errorMessage(e)))
            }
          >
            <TranslateIcon className={translator.busy ? 'animate-pulse' : ''} />
          </IconButton>
        )}
        {!busy && <VoiceInputButton chatId={chatId} onText={(v) => setText((s) => (s.trim() ? `${s} ${v}` : v))} />}
        {busy ? (
          <IconButton
            label={t('停止')}
            onClick={() =>
              stopImpersonate ? stopImpersonate() : api.abort(chatId).catch((e) => toast.error(errorMessage(e)))
            }
            className="bg-zinc-200 dark:bg-zinc-800"
          >
            <StopIcon />
          </IconButton>
        ) : (
          <IconButton
            label={t('发送')}
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

/** 语音输入：音频扩展开了语音识别才显示；点一下开始录，再点一下停止并把识别结果接到输入框里 */
function VoiceInputButton({ chatId, onText }: { chatId: string; onText: (text: string) => void }) {
  const extensions = useExtensions()
  const audio = extensions.data?.find((e) => e.id === 'audio')
  const enabled = !isRoomGuest(chatId) && !!audio?.enabled && (audio.settings.asrEngine ?? 'off') !== 'off'
  const recorder = useVoiceRecorder()
  const handled = useRef('')
  useEffect(() => {
    if (recorder.text && recorder.text !== handled.current) {
      handled.current = recorder.text
      onText(recorder.text)
    }
  }, [recorder.text, onText])
  useEffect(() => {
    if (recorder.error) toast.error(errorMessage(recorder.error))
  }, [recorder.error])
  if (!enabled || typeof MediaRecorder === 'undefined') return null
  if (recorder.state === 'recording')
    return (
      <IconButton
        label={t('停止录音并识别')}
        onClick={recorder.stop}
        className="bg-red-500 text-white hover:bg-red-400 hover:text-white dark:text-white"
      >
        <span className="size-3 animate-pulse rounded-sm bg-white" />
      </IconButton>
    )
  return (
    <IconButton
      label={recorder.state === 'transcribing' ? t('识别中…') : t('语音输入')}
      disabled={recorder.state === 'transcribing'}
      onClick={() => void recorder.start()}
    >
      <MicIcon className={recorder.state === 'transcribing' ? 'animate-pulse' : ''} />
    </IconButton>
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
