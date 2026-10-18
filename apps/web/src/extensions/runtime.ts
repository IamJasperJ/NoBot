import type { ExtensionDTO, MessageDTO } from '@ai-parter/shared'
import type { QueryClient } from '@tanstack/react-query'
import * as React from 'react'
import { create } from 'zustand'
import { api } from '../api/client'
import { registerCommand } from '../commands/registry'
import { getLanguage, t } from '../i18n'
import { errorMessage, toast } from '../stores/toast'
import { useUi, type View } from '../stores/ui'
import { BUILTIN_CLIENTS } from './builtin'
import type { ActivateFn, ClientEvent, ClientExtensionAPI, PageContribution, SlotName, SlotProps } from './types'

type Owned<T> = T & { extensionId: string }
type SlotEntry = Owned<{
  slot: SlotName
  id: string
  title?: string
  order: number
  render: (props: never) => React.ReactNode
}>
type Transform = Owned<{ fn: (text: string, message: MessageDTO) => string }>
type Listener = Owned<{ type: ClientEvent['type']; handler: (event: ClientEvent) => void }>

export const useExtensionsRuntime = create<{
  slots: SlotEntry[]
  pages: Owned<PageContribution>[]
  transforms: Transform[]
  listeners: Listener[]
}>(() => ({ slots: [], pages: [], transforms: [], listeners: [] }))

interface Running {
  active: boolean
  cleanup?: () => void
  style?: HTMLLinkElement
  commands?: (() => void)[]
  commandLanguage?: string
}
const running = new Map<string, Running>()

function remove(id: string) {
  const entry = running.get(id)
  if (entry) {
    entry.active = false
    for (const dispose of entry.commands ?? []) dispose()
    try {
      entry.cleanup?.()
    } catch (e) {
      toast.error(t('扩展 {id} 清理失败：{error}', { id, error: errorMessage(e) }))
    }
    entry.style?.remove()
    running.delete(id)
  }
  useExtensionsRuntime.setState((s) => ({
    slots: s.slots.filter((x) => x.extensionId !== id),
    pages: s.pages.filter((x) => x.extensionId !== id),
    transforms: s.transforms.filter((x) => x.extensionId !== id),
    listeners: s.listeners.filter((x) => x.extensionId !== id),
  }))
  const ui = useUi.getState()
  if (ui.view === 'extensions' && ui.focusId === id && ui.extensionPageId !== null) {
    useUi.setState({ extensionPageId: null })
  }
}

function makeAPI(id: string, entry: Running, queryClient: QueryClient): ClientExtensionAPI {
  const add = <K extends keyof ReturnType<typeof useExtensionsRuntime.getState>>(
    key: K,
    value: ReturnType<typeof useExtensionsRuntime.getState>[K][number],
  ) => {
    if (entry.active) useExtensionsRuntime.setState((s) => ({ [key]: [...s[key], value] }))
  }
  return {
    id,
    React,
    api,
    queryClient,
    toast,
    openView: (view, focusId) => useUi.getState().openView(view as View | `ext:${string}:${string}`, focusId),
    getChatId: () => useUi.getState().chatId,
    openChat: async (chatId) => {
      const page = await api.getChatPage(chatId)
      useUi.getState().openChat({ characterId: page.chat.characterId, groupId: page.chat.groupId }, chatId)
      useUi.getState().openView('chat')
    },
    getSettings: async () => (await api.listExtensions()).find((x) => x.id === id)?.settings ?? {},
    saveSettings: async (settings) => {
      await api.updateExtension(id, { settings })
      await queryClient.invalidateQueries({ queryKey: ['extensions'] })
    },
    fetchServer: (path, init) => {
      // 固定同源和扩展前缀，拒绝 URL、查询之外的目录跳转。
      const url = new URL(`/api/ext/${id}/${path.replace(/^\/+/, '')}`, location.origin)
      if (url.origin !== location.origin || !url.pathname.startsWith(`/api/ext/${id}/`)) {
        return Promise.reject(new Error(t('扩展接口路径不合法')))
      }
      return fetch(url, init)
    },
    registerCommand: (command) => {
      if (entry.active) {
        entry.commandLanguage = getLanguage()
        entry.commands ??= []
        entry.commands.push(registerCommand(command))
      }
    },
    registerSlot: (slot, contribution) => {
      if (!entry.active) return
      useExtensionsRuntime.setState((s) => ({
        slots: s.slots.filter((x) => !(x.extensionId === id && x.slot === slot && x.id === contribution.id)),
      }))
      add('slots', {
        ...contribution,
        // 保留内置扩展的动态标题，切换语言后读取时再翻译。
        get title() {
          return contribution.title
        },
        slot,
        order: contribution.order ?? 100,
        extensionId: id,
        render: contribution.render as (props: never) => React.ReactNode,
      })
    },
    registerPage: (page) => {
      if (!entry.active) return
      useExtensionsRuntime.setState((s) => ({
        pages: s.pages.filter((x) => !(x.extensionId === id && x.id === page.id)),
      }))
      add('pages', {
        ...page,
        get label() {
          return page.label
        },
        extensionId: id,
      })
    },
    registerMessageTransform: (fn) => add('transforms', { fn, extensionId: id }),
    on: (type, handler) => {
      const listener: Listener = { type, extensionId: id, handler: handler as (event: ClientEvent) => void }
      add('listeners', listener)
      return () => useExtensionsRuntime.setState((s) => ({ listeners: s.listeners.filter((x) => x !== listener) }))
    },
  }
}

async function activate(extension: ExtensionDTO, queryClient: QueryClient, existing?: Running) {
  const id = extension.id
  const entry: Running = existing ?? { active: true }
  running.set(id, entry)
  try {
    if (extension.client.style) {
      entry.style = document.createElement('link')
      entry.style.rel = 'stylesheet'
      entry.style.href = `/api/extensions/${id}/style.css`
      document.head.append(entry.style)
    }
    const builtin = extension.source === 'builtin' ? BUILTIN_CLIENTS[id] : undefined
    if (builtin) {
      const cleanup = await builtin(makeAPI(id, entry, queryClient))
      if (typeof cleanup === 'function') entry.cleanup = cleanup
    } else if (extension.client.script) {
      const path = `/api/extensions/${id}/client.js`
      const module = await import(/* @vite-ignore */ path)
      if (typeof module.default !== 'function') throw new Error(t('前端入口必须默认导出 activate 函数'))
      const cleanup = await (module.default as ActivateFn)(makeAPI(id, entry, queryClient))
      if (typeof cleanup === 'function') entry.cleanup = cleanup
    }
  } catch (e) {
    remove(id)
    toast.error(t('扩展 {name} 加载失败：{error}', { name: extension.name, error: errorMessage(e) }))
  }
}

// 串行处理加载请求，避免 StrictMode 和连续切换重复注册贡献。
let queue: Promise<void> = Promise.resolve()
export function loadExtensions(queryClient: QueryClient, reloadId?: string) {
  queue = queue.then(async () => {
    try {
      const extensions = await api.listExtensions()
      for (const id of running.keys()) {
        if (
          id === reloadId ||
          (running.get(id)?.commandLanguage && running.get(id)?.commandLanguage !== getLanguage()) ||
          !extensions.some((x) => x.id === id && x.enabled && !x.loadError)
        )
          remove(id)
      }
      for (const extension of extensions) {
        if (!extension.enabled || extension.loadError || !extension.commands?.length || running.has(extension.id))
          continue
        const entry: Running = { active: true, commandLanguage: getLanguage() }
        // 后端命令也属于扩展生命周期，停用或重载时统一注销。
        running.set(extension.id, entry)
        try {
          entry.commands ??= []
          for (const command of extension.commands)
            entry.commands.push(
              registerCommand({
                ...command,
                run: async (ctx, args, text) => {
                  const result = await api.extensionCommand(extension.id, command.name, ctx.chatId, args, text)
                  await ctx.refresh()
                  return result.result
                },
              }),
            )
          await activate(extension, queryClient, entry)
        } catch (e) {
          remove(extension.id)
          toast.error(t('扩展 {name} 加载失败：{error}', { name: extension.name, error: errorMessage(e) }))
        }
      }
      for (const extension of extensions) {
        if (
          extension.enabled &&
          !extension.loadError &&
          !running.has(extension.id) &&
          (extension.client.script ||
            extension.client.style ||
            (extension.source === 'builtin' && BUILTIN_CLIENTS[extension.id]))
        )
          await activate(extension, queryClient)
      }
    } catch (e) {
      toast.error(t('扩展列表加载失败：{error}', { error: errorMessage(e) }))
    }
  })
  return queue
}

export function emitClientEvent(event: ClientEvent) {
  for (const listener of useExtensionsRuntime.getState().listeners) {
    if (listener.type !== event.type) continue
    try {
      listener.handler(event)
    } catch (e) {
      toast.error(t('扩展 {id} 事件出错：{error}', { id: listener.extensionId, error: errorMessage(e) }))
    }
  }
}

export function transformMessage(text: string, message: MessageDTO, transforms: Transform[]) {
  return transforms.reduce((value, entry) => {
    try {
      return entry.fn(value, message)
    } catch (e) {
      console.error(`扩展 ${entry.extensionId} 消息变换出错：`, e)
      return value
    }
  }, text)
}

/** 将泛型插槽的参数关联限制在调用侧，存储时统一擦除具体类型。 */
export function slotProps<K extends SlotName>(props: SlotProps[K]): never {
  return props as never
}

/** 只有已启用扩展的有效订阅才允许从最后一张请求生成新图片。 */
export function hasListener(type: ClientEvent['type']): boolean {
  return useExtensionsRuntime.getState().listeners.some((listener) => listener.type === type)
}
