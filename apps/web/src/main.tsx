import './migrate-local-storage'
import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { queryClient } from './api/queryClient'
import './index.css'
import { initLanguage, useLanguage } from './i18n'
import { initAppearance } from './stores/appearance'

// 先应用外观设置（主题、字号），避免首屏闪一下默认样式
initAppearance()
void initLanguage()

/** 切换界面语言时整个应用重新挂载：t() 是普通函数，这样所有文字都会按新语言重新渲染 */
function Root() {
  const language = useLanguage((s) => s.language)
  return <App key={language} />
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </StrictMode>,
)
