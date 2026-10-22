import type { AttachmentDTO } from '@nobot/shared'
import type { QueryClient } from '@tanstack/react-query'
import { t } from '../../../i18n'

/** 查询观察者也会在渲染期间通知缓存；只订阅聊天数据，并在当前调用栈结束后刷新组件。 */
export function subscribeChatCache(queryClient: QueryClient, chatId: string, notify: () => void) {
  let active = true
  let queued = false
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' && event.type !== 'removed') return
    const key = event.query.queryKey
    if (key.length !== 2 || key[0] !== 'chat' || key[1] !== chatId || queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      if (active) notify()
    })
  })
  return () => {
    active = false
    unsubscribe()
  }
}

export const imageModes = () =>
  [
    ['character', t('角色（全身）')],
    ['face', t('角色（脸部特写）')],
    ['user', t('用户（人设）')],
    ['scene', t('当前场景')],
    ['last', t('最后一条消息')],
    ['message', t('指定消息')],
    ['raw_last', t('最后一条消息原文')],
    ['background', t('背景')],
    ['free', t('自由描述…')],
  ] as const
export const buttonClass = 'rounded px-3 py-1.5 text-left text-sm hover:bg-zinc-500/10 disabled:opacity-50'
export interface Preview {
  snapshotId: string
  prompt: string
  negative: string
  width: number
  height: number
  source: string
  model: string
  workflow: string
}
export interface GalleryImage {
  chatId: string
  messageId: string
  image: AttachmentDTO
  prompt: string
  createdAt: number
}
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
