import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../i18n'
import { XIcon } from './icons'

/**
 * 站内看大图：铺满窗口的遮罩，点遮罩、点关闭按钮或按 Esc 收起。
 * 代替原来的新标签页打开，避免离开聊天页面。
 */
export function Lightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  const view = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt || t('查看图片')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      // 只有点在遮罩本身（图片外）才关闭
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <img src={src} alt={alt ?? ''} className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
      <button
        type="button"
        aria-label={t('关闭')}
        title={t('关闭')}
        className="absolute top-3 right-3 inline-flex size-9 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25 [&_svg]:size-5"
        onClick={onClose}
      >
        <XIcon />
      </button>
    </div>
  )
  return typeof document === 'undefined' ? view : createPortal(view, document.body)
}
