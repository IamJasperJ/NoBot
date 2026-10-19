import type { MessageDTO } from '@nobot/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { useFreshMessage } from '../stores/freshMessages'
import { api } from './client'
import { keys, replaceMessage, useExtensions } from './queries'

const temporaryViews = new Map<string, boolean>()
const viewListeners = new Set<() => void>()
const viewKey = (id: string) => `translation:view:${id}`
function readView(id: string) {
  try {
    return temporaryViews.get(id) ?? localStorage.getItem(viewKey(id)) !== 'false'
  } catch {
    return temporaryViews.get(id) ?? true
  }
}
function subscribeView(listener: () => void) {
  viewListeners.add(listener)
  globalThis.addEventListener?.('storage', listener)
  return () => {
    viewListeners.delete(listener)
    globalThis.removeEventListener?.('storage', listener)
  }
}

/**
 * F4 翻译扩展（内置扩展 translate，接口前缀 /api/ext/translate/）的前端数据层。
 * 扩展未启用时 enabled=false，界面不显示任何翻译入口。
 */

/** 翻译扩展是否启用（看扩展列表里 translate 的 enabled） */
export function useTranslateEnabled(): boolean {
  return useExtensions().data?.find((extension) => extension.id === 'translate')?.enabled ?? false
}

/**
 * 单条消息的翻译操作。translate / remove 完成后用返回的 MessageDTO 替换缓存里的这条消息（和图片扩展更新消息的方式一致）。
 * busy：这条消息正在翻译 / 移除
 */
export function useMessageTranslation(
  chatId: string,
  message: MessageDTO,
): {
  translate: () => Promise<void>
  remove: () => Promise<void>
  busy: boolean
} {
  const qc = useQueryClient()
  const translate = useMutation({
    mutationFn: () => api.translateMessage(message.id),
    onSuccess: (updated) => replaceMessage(qc, chatId, updated),
  })
  const remove = useMutation({
    mutationFn: () => api.removeTranslation(message.id),
    onSuccess: (updated) => replaceMessage(qc, chatId, updated),
  })
  return {
    translate: async () => {
      await translate.mutateAsync()
    },
    remove: async () => {
      await remove.mutateAsync()
    },
    busy: translate.isPending || remove.isPending,
  }
}

/**
 * 某条消息当前显示译文还是原文（每个浏览器本地记住，不进数据库；默认显示译文）。
 * - direction display：showTranslation=true 时显示 translation.text
 * - direction source：showTranslation=true 时显示我写的原文 translation.text，false 时显示实际发给模型的 content
 * stale：translation.sourceHash 和当前 content 的哈希对不上（正文被编辑过），哈希算法要和后端一致（读后端实现）
 */
export function useTranslationView(message: MessageDTO): {
  hasTranslation: boolean
  showTranslation: boolean
  toggle: () => void
  /** 当前应该显示的正文 */
  text: string
  /** 当前应该显示的思考过程（有译文且显示译文时用译文） */
  reasoning: string | undefined
  stale: boolean
} {
  const translation = message.meta.translation
  const showTranslation = useSyncExternalStore(
    subscribeView,
    () => readView(message.id),
    () => readView(message.id),
  )
  const hash = useQuery({
    queryKey: ['translationHash', message.content],
    queryFn: async () => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message.content))
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    },
    enabled: !!translation,
    staleTime: Infinity,
  }).data
  return {
    hasTranslation: !!translation,
    showTranslation,
    toggle: () => {
      const next = !readView(message.id)
      try {
        localStorage.setItem(viewKey(message.id), String(next))
        temporaryViews.delete(message.id)
      } catch {
        // 禁用存储时仍允许本次页面中切换。
        temporaryViews.set(message.id, next)
      }
      for (const listener of viewListeners) listener()
    },
    text: translation && showTranslation ? translation.text : message.content,
    reasoning:
      translation && showTranslation ? (translation.reasoning ?? message.meta.reasoning) : message.meta.reasoning,
    stale: !!translation && hash !== undefined && translation.sourceHash !== hash,
  }
}

/** 输入框的「翻译」按钮：把文本翻成模型语言（扩展设置的 internalLanguage），返回译文 */
export function useTranslateText(): { translate: (text: string) => Promise<string>; busy: boolean } {
  const extension = useExtensions().data?.find((item) => item.id === 'translate')
  const lang =
    typeof extension?.settings.internalLanguage === 'string' && extension.settings.internalLanguage
      ? extension.settings.internalLanguage
      : 'en'
  const mutation = useMutation({ mutationFn: (text: string) => api.translateText(text, lang) })
  return { translate: async (text) => (await mutation.mutateAsync(text)).text, busy: mutation.isPending }
}

/** 自动翻译回复时，回复已经入库但译文还没好：界面可以显示一个「翻译中」的小标记 */
export function useTranslationPending(message: MessageDTO): boolean {
  const qc = useQueryClient()
  const extension = useExtensions().data?.find((item) => item.id === 'translate')
  const fresh = useFreshMessage(message.id, 60000)
  const pending =
    !!extension?.enabled &&
    ['responses', 'both'].includes(String(extension.settings.autoMode)) &&
    fresh &&
    message.role === 'assistant' &&
    message.status === 'done' &&
    !message.meta.translation
  useQuery({
    queryKey: ['translationPending', message.chatId, message.id],
    queryFn: async () => {
      // 没有单条消息读取接口，复用会话刷新；历史页和当前分支仍由原查询维护。
      await qc.invalidateQueries({ queryKey: keys.chat(message.chatId) })
      return null
    },
    enabled: pending,
    refetchInterval: pending ? 2000 : false,
  })
  return pending
}
