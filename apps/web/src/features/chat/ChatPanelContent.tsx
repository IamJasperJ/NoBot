import { type PointerEvent, useRef } from 'react'
import { SIDEBAR_MAX, SIDEBAR_MIN, useAppearance } from '../../stores/appearance'
import { useUi } from '../../stores/ui'
import { Sidebar } from '../characters/Sidebar'
import { ChatSettings } from './ChatSettings'
import { PromptPreview } from './PromptPreview'

/** 聊天导航项的面板内容，宽度和拖拽手柄统一由应用外壳提供。 */
export function ChatPanelContent() {
  const { chatId, chatSettingsOpen, previewOpen } = useUi()
  if (chatId && chatSettingsOpen) return <ChatSettings chatId={chatId} />
  if (chatId && previewOpen) return <PromptPreview chatId={chatId} />
  return <Sidebar />
}

/** 拖动右边缘调节侧栏宽度 */
export function ResizeHandle() {
  const start = useRef<{ x: number; width: number } | null>(null)

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { x: e.clientX, width: useAppearance.getState().sidebarWidth }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return
    const width = Math.round(start.current.width + e.clientX - start.current.x)
    useAppearance.getState().set({ sidebarWidth: Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)) })
  }
  const onPointerUp = () => {
    start.current = null
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: 可拖动的分隔条，<hr> 不能接收指针拖动
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调整侧栏宽度"
      title="拖动调整宽度，双击恢复默认"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onPointerUp}
      onDoubleClick={() => useAppearance.getState().set({ sidebarWidth: 288 })}
      className="absolute inset-y-0 -right-1 z-10 hidden w-2 touch-none cursor-col-resize hover:bg-violet-500/30 md:block"
    />
  )
}
