import type { MessageDTO } from '@ai-parter/shared'
import { useEffect, useRef, useState } from 'react'
import { XIcon } from '../../components/icons'
import { cx } from '../../components/ui'
import { t } from '../../i18n'
import { MessageMedia } from '../chat/MessageItem'

/**
 * VN 视图里的图片框：生成的图片（含占位、失败、备选切换、设为背景、改提示词）不进对话框，
 * 而是放在右上角的浮动卡片里，内容直接复用聊天视图的 MessageMedia，两边行为一致。
 *
 * - 有新的图片消息（生成开始时就会有占位消息）自动展开；刚进入 VN 时只有最后一条就是图片才展开，
 *   避免每次打开会话都弹出很久以前的图
 * - 收起后顶部按钮上有圆点：紫色 = 正在生成，白色 = 有没看过的新图
 */
export function useVnImages(messages: MessageDTO[]) {
  const images = messages.filter((m) => m.role !== 'user' && (m.meta.imageGen || m.meta.images?.length))
  const latest = images.at(-1) ?? null
  const lastId = messages.at(-1)?.id
  const [open, setOpen] = useState(false)
  const [seen, setSeen] = useState<string | null>(null)
  const [unread, setUnread] = useState(false)
  useEffect(() => {
    if (!latest || latest.id === seen) return
    // seen 为 null 表示刚进入：只有最后一条就是这张图时才展开
    const fresh = seen !== null || lastId === latest.id
    setSeen(latest.id)
    if (fresh) setOpen(true)
  }, [latest, seen, lastId])
  // 收起状态下多出了图片（新的备选图，或同步生成时直接带图回来的消息）→ 记一个「有新图」。
  // 不看「生成中 → 完成」：同步生成时前端根本看不到生成中这一步
  const status = latest?.meta.imageGen?.status
  const signature = latest ? `${latest.id}:${latest.meta.images?.length ?? 0}` : ''
  const prevSignature = useRef(signature)
  useEffect(() => {
    if (signature !== prevSignature.current && !open && (latest?.meta.images?.length ?? 0) > 0) setUnread(true)
    prevSignature.current = signature
  }, [signature, open, latest])
  return {
    latest,
    open,
    pending: status === 'pending',
    unread: unread && !open,
    toggle: () => {
      setOpen(!open)
      setUnread(false)
    },
    close: () => setOpen(false),
  }
}

export function VnImageCard({
  chatId,
  message,
  mobile,
  side = 'right',
  onClose,
}: {
  chatId: string
  message: MessageDTO
  mobile: boolean
  /** 宽屏时放在哪一侧（HUD 占了右上角时放左边） */
  side?: 'left' | 'right'
  onClose: () => void
}) {
  return (
    <div
      role="dialog"
      aria-label={t('图片')}
      className={cx(
        'vn-image-card absolute z-20 max-h-[calc(100%-8rem)] overflow-y-auto rounded-2xl px-3 pt-2 pb-1',
        mobile ? 'inset-x-3 top-14' : cx('top-14 w-[344px]', side === 'left' ? 'left-3' : 'right-3'),
      )}
    >
      <div className="flex h-7 items-center gap-2 text-xs">
        <span className="flex-1 truncate font-medium opacity-70">{message.meta.name || t('图片')}</span>
        <button
          type="button"
          aria-label={t('收起图片')}
          title={t('收起图片')}
          className="flex size-7 items-center justify-center rounded-full opacity-60 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <MessageMedia msg={message} chatId={chatId} />
    </div>
  )
}
