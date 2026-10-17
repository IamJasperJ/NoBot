import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'

/**
 * 拖动 / 缩放立绘的手势（VN 舞台和聊天视图的侧边立绘共用）：
 * - 一根手指或鼠标按住拖：移动，回调给出相对按下时的位移（像素）
 * - 两根手指捏合：缩放，回调给出相对按下时的倍数
 * - 滚轮：每格缩放约 5%
 * 用法：把 bind() 的返回值展开到立绘元素上
 */
export interface GestureHandlers {
  /** 开始一次拖动 / 捏合：记下起始值 */
  onStart: () => void
  onMove: (dx: number, dy: number) => void
  onPinch: (ratio: number) => void
  /** 滚轮：乘上这个倍数 */
  onWheel: (factor: number) => void
}

export function spriteGesture(handlers: GestureHandlers) {
  const pointers = new Map<number, { x: number; y: number }>()
  let origin: { x: number; y: number } | null = null
  let pinchFrom = 0

  const distance = () => {
    const [a, b] = [...pointers.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }

  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      e.stopPropagation()
      // 捕获指针：手指移出立绘也继续跟着拖。个别情况（指针已经失效）会抛错，不影响拖动本身
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // 忽略
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      handlers.onStart()
      if (pointers.size === 1) origin = { x: e.clientX, y: e.clientY }
      if (pointers.size === 2) {
        origin = null
        pinchFrom = distance()
      }
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      if (!pointers.has(e.pointerId)) return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size === 2 && pinchFrom > 0) handlers.onPinch(distance() / pinchFrom)
      else if (pointers.size === 1 && origin) handlers.onMove(e.clientX - origin.x, e.clientY - origin.y)
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      pointers.delete(e.pointerId)
      // 捏合松开一根手指后，剩下那根从当前位置重新开始拖
      if (pointers.size === 1) {
        const [rest] = [...pointers.values()]
        handlers.onStart()
        origin = rest ?? null
      } else origin = null
    },
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => {
      pointers.delete(e.pointerId)
      origin = null
    },
    onWheel: (e: ReactWheelEvent<HTMLElement>) => {
      e.stopPropagation()
      handlers.onWheel(Math.exp(-e.deltaY * 0.0015))
    },
  }
}
