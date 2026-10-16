import { type PointerEvent, useRef } from 'react'
import { SIDEBAR_MAX, SIDEBAR_MIN, useAppearance } from '../../stores/appearance'
import { useUi } from '../../stores/ui'
import { Sidebar } from '../characters/Sidebar'
import { ChatSettings } from './ChatSettings'
import { PromptPreview } from './PromptPreview'

/**
 * 聊天页左侧的面板位：平时是会话列表（Sidebar）；
 * 打开「会话设置」或「Prompt 预览」时，面板就在这个位置替换会话列表，不遮挡对话区。
 * 宽屏下右边缘可以拖动调节宽度（也可以在设置页里填数值）。
 */
export function SidePanel() {
  const { chatId, chatSettingsOpen, previewOpen } = useUi()

  let content = <Sidebar />
  if (chatId && chatSettingsOpen) content = <ChatSettings chatId={chatId} />
  else if (chatId && previewOpen) content = <PromptPreview chatId={chatId} />

  return (
    // 手机上侧栏在抽屉里，宽度不能超过屏幕减去导航栏
    <div className="relative h-full w-[min(var(--sidebar-width),calc(100vw-4rem))] shrink-0 md:w-[var(--sidebar-width)]">
      {content}
      <ResizeHandle />
    </div>
  )
}

/** 拖动右边缘调节侧栏宽度 */
function ResizeHandle() {
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
      onDoubleClick={() => useAppearance.getState().set({ sidebarWidth: 288 })}
      className="absolute inset-y-0 -right-1 z-10 hidden w-2 cursor-col-resize hover:bg-violet-500/30 md:block"
    />
  )
}
