import './migrate-local-storage'
import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { queryClient } from './api/queryClient'
import './index.css'
import { LoginPage } from './features/auth/LoginPage'
import { initLanguage, useLanguage } from './i18n'
import { isMiniApp } from './miniapp/context'
import { MiniApp } from './miniapp/MiniApp'
import { initAppearance } from './stores/appearance'
import { initSession, useSessionStore } from './stores/session'

// 先应用外观设置（主题、字号），避免首屏闪一下默认样式
initAppearance()
// 未登录时语言设置接口会 401，只用本机缓存
if (!isMiniApp())
  void initSession().then(() => {
    if (useSessionStore.getState().status === 'authenticated') void initLanguage()
  })

/** 切换界面语言时整个应用重新挂载：t() 是普通函数，这样所有文字都会按新语言重新渲染 */
function Root() {
  const language = useLanguage((s) => s.language)
  const status = useSessionStore((s) => s.status)
  // 等待会话检查和旧 ID 清理完成，防止先挂载的查询请求上一位用户的会话。
  if (isMiniApp()) return <MiniApp key={language} />
  if (status === 'loading') return null
  if (status === 'anonymous') return <LoginPage key={language} />
  return <App key={language} />
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </StrictMode>,
)
