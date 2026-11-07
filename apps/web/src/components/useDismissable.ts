import { type RefObject, useEffect, useLayoutEffect, useState } from 'react'

/**
 * 让基于 <details> 的下拉菜单在点外面或按 Esc 时收起。
 * 同一时间只留一个菜单：点另一个菜单的按钮也算「点外面」，原来的会关掉。
 */
export function useDismissableDetails(ref: RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    const close = (event: Event) => {
      const el = ref.current
      if (!el?.open) return
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') el.removeAttribute('open')
        return
      }
      if (event.target instanceof Node && !el.contains(event.target)) el.removeAttribute('open')
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', close)
    }
  }, [ref])
}

/** 最近的会裁剪内容的祖先（滚动容器）的下边界；没有时用窗口底部 */
function clipBottom(el: HTMLElement) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden')
      return Math.min(node.getBoundingClientRect().bottom, window.innerHeight)
  }
  return window.innerHeight
}

/**
 * 菜单打开时判断下面放不放得下：放不下且上面空间更大时改为向上展开。
 * 聊天列表底部被输入框挡住，所以按滚动容器的下边界算，而不只是窗口。
 */
export function useFlipUp(ref: RefObject<HTMLDetailsElement | null>, menu: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(false)
  const [up, setUp] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onToggle = () => setOpen(el.open)
    el.addEventListener('toggle', onToggle)
    return () => el.removeEventListener('toggle', onToggle)
  }, [ref])
  useLayoutEffect(() => {
    const el = ref.current
    const box = menu.current
    if (!open || !el || !box) return
    const anchor = el.getBoundingClientRect()
    const below = clipBottom(el) - anchor.bottom
    const above = anchor.top
    setUp(box.offsetHeight + 8 > below && above > below)
  }, [open, ref, menu])
  return up
}
