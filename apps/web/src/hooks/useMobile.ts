import { useSyncExternalStore } from 'react'

const mobileQuery = () => window.matchMedia('(max-width: 767px)')
const subscribe = (notify: () => void) => {
  const query = mobileQuery()
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}
const getSnapshot = () => mobileQuery().matches

/** 与布局的 md 断点保持一致，切换窗口宽度时同步抽屉和面板的挂载状态。 */
export function useMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
