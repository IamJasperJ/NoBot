import type { MessageDTO } from '@ai-parter/shared'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useMobile } from '../../hooks/useMobile'
import { useStreaming } from '../../stores/streaming'
import { type ChatCast, MessageItem } from './MessageItem'

interface Props {
  chatId: string
  messages: MessageDTO[]
  busy: boolean
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => void
  cast: ChatCast
}

/** 距离底部多少像素以内算「停在底部」 */
const BOTTOM_THRESHOLD = 80

/**
 * 消息列表，用虚拟列表实现：只渲染视口内的消息加上下各几条，
 * 几千条消息的会话也只有十几个 DOM 节点。
 */
export function MessageList({ chatId, messages, busy, hasMore, loadingMore, loadMore, cast }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)

  const mobile = useMobile()
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 5,
    getItemKey: (i) => messages[i]?.id ?? i,
    // 没有顶部标题栏了：列表顶部留出空白，手机上还要让开左上角打开抽屉的悬浮按钮
    paddingStart: mobile ? 56 : 16,
  })

  // 流式输出时文本在变长：订阅长度，用来判断要不要跟着滚到底
  const streamingLength = useStreaming((s) => (s.chatId === chatId ? s.text.length + s.reasoning.length : 0))

  const scrollToBottom = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  // 切换会话时回到底部
  useLayoutEffect(() => {
    atBottom.current = true
    if (messages.length > 0) virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })
  }, [chatId])

  // 有新消息或正在生成时，只有用户停在底部才跟随滚动，不打扰往上翻看的用户
  const lastId = messages.at(-1)?.id
  useLayoutEffect(() => {
    if (atBottom.current) scrollToBottom()
  }, [lastId, streamingLength, virtualizer.getTotalSize()])

  // 加载更早的消息后，保持当前看到的内容不跳动
  const firstId = messages[0]?.id
  const prevFirst = useRef(firstId)
  const prevHeight = useRef(0)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && prevFirst.current && firstId !== prevFirst.current && !atBottom.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current
    }
    prevFirst.current = firstId
  }, [firstId])

  useEffect(() => {
    if (scrollRef.current) prevHeight.current = scrollRef.current.scrollHeight
  })

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD
    if (el.scrollTop < 300 && hasMore && !loadingMore) {
      prevHeight.current = el.scrollHeight
      loadMore()
    }
  }

  const items = virtualizer.getVirtualItems()
  return (
    <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {loadingMore && <div className="py-2 text-center text-xs text-zinc-400">加载更早的消息…</div>}
      <div className="chat-column relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        <div className="absolute inset-x-0 top-0" style={{ transform: `translateY(${items[0]?.start ?? 0}px)` }}>
          {items.map((item) => {
            const msg = messages[item.index] as MessageDTO
            return (
              <div key={item.key} data-index={item.index} ref={virtualizer.measureElement}>
                <MessageItem
                  msg={msg}
                  chatId={chatId}
                  isLast={item.index === messages.length - 1}
                  busy={busy}
                  cast={cast}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
