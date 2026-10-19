import type { ChatPage, ExtensionDTO, MessageDTO } from '@nobot/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { keys } from './queries'

export const message: MessageDTO = {
  id: 'reply',
  chatId: 'chat',
  parentId: null,
  role: 'assistant',
  content: 'Hello 世界',
  status: 'done',
  speakerId: null,
  meta: {},
  createdAt: 0,
  swipeIndex: 1,
  swipeCount: 1,
}
export const extension: ExtensionDTO = {
  id: 'translate',
  name: '',
  description: '',
  author: '',
  version: '1',
  source: 'builtin',
  enabled: true,
  client: { script: false, style: false },
  hasRoutes: true,
  provides: { macros: [], hooks: [], tools: [] },
  settingsSchema: [],
  settings: { autoMode: 'both', internalLanguage: 'ja' },
  permissions: null,
  detected: { server: true, client: false, routes: true, tools: false, hooks: true },
  permissionWarnings: [],
  needsApproval: false,
  git: null,
  revision: '1',
}
export function setupHooks() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  })
  // 这里只使用消息和生效预设字段，其余会话元数据由各测试按需提供。
  const page = { messages: [message], hasMore: false, playPresetId: 'play' } as ChatPage
  qc.setQueryData(keys.chat('chat'), { pages: [page], pageParams: [undefined] })
  const render = <T,>(hook: () => T): T => {
    let result: T | undefined
    function Probe() {
      result = hook()
      return null
    }
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    )
    return result as T
  }
  return { qc, render, page }
}
